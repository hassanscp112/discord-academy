// Coach web server: the Arabic owner dashboard SPA (public/) + its cookie-auth API.
import express from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as A from '../core/academy.js';
import { getSetting, setSetting, allSettings, getDb } from '../core/db.js';
import { fmtInTz, zonedToUtc, normalizeTemplate } from '../core/time.js';
import { config } from '../core/config.js';
import { stopStream, playerState, controlPlayer } from './streamer.js';
import { fetchPlaylist, fetchVideoMeta } from './importer.js';
import { publishBook, unpublishBook, syncLibrary } from './library.js';
import { systemStatus, saveCookies, restoreDatabase, makeBackup } from './maintenance.js';
import { markAllMembersDirty } from './memberdash.js';
import { syncCourseCards } from './coursereg.js';
import { refreshAcademyDashboard } from './acadashboard.js';
import { startSessionNow, finishSession } from './sessions.js';
import { templates } from '../core/templates.js';

const here = dirname(fileURLToPath(import.meta.url));
const sha256 = v => createHash('sha256').update(String(v)).digest();
// constant-time compare; an unset secret never matches (dry-run has no password)
const sameSecret = (given, secret) => !!secret && timingSafeEqual(sha256(given ?? ''), sha256(secret));

// ---- dashboard sessions: random per-login tokens, stored hashed in data/ so they
// survive restarts; logout revokes one, changing DASH_PASSWORD revokes all ----
const SESSION_MS = 30 * 86400000;
const SESSIONS_FILE = 'data/dash-sessions.json';
const pwTag = () => sha256(`academy:${config.dashPassword}`).toString('hex').slice(0, 16);
let sessions = null; // { pw, tokens: { sha256(token) -> expiresAt } }
function loadSessions() {
  if (sessions?.pw === pwTag()) return sessions;
  try {
    const s = JSON.parse(readFileSync(SESSIONS_FILE, 'utf8'));
    sessions = s.pw === pwTag() && s.tokens ? s : { pw: pwTag(), tokens: {} };
  } catch { sessions = { pw: pwTag(), tokens: {} }; }
  return sessions;
}
function saveSessions() {
  const now = Date.now();
  const live = Object.entries(sessions.tokens).filter(([, exp]) => exp > now).sort((a, b) => b[1] - a[1]).slice(0, 50);
  sessions.tokens = Object.fromEntries(live);
  try { mkdirSync('data', { recursive: true }); writeFileSync(SESSIONS_FILE, JSON.stringify(sessions)); }
  catch (e) { console.log('[web] could not persist sessions:', e.message); }
}
function createSession() {
  const token = randomBytes(32).toString('base64url');
  loadSessions().tokens[sha256(token).toString('hex')] = Date.now() + SESSION_MS;
  saveSessions();
  return token;
}
function validSession(token) {
  if (!token || token.length > 100) return false;
  return (loadSessions().tokens[sha256(token).toString('hex')] ?? 0) > Date.now();
}
function revokeSession(token) {
  if (!token) return;
  const s = loadSessions();
  const key = sha256(token).toString('hex');
  if (key in s.tokens) { delete s.tokens[key]; saveSessions(); }
}

// ---- login brute-force brake: 5 failures / 15 min per client IP, plus 30 / 15 min
// across everyone (still holds if X-Forwarded-For is spoofed) ----
const FAIL_WINDOW_MS = 15 * 60000;
const failsByIp = new Map();
let allFails = [];
const recent = list => list.filter(t => Date.now() - t < FAIL_WINDOW_MS);
function loginBlocked(ip) {
  allFails = recent(allFails);
  return recent(failsByIp.get(ip) ?? []).length >= 5 || allFails.length >= 30;
}
function noteLoginFailure(ip) {
  failsByIp.set(ip, [...recent(failsByIp.get(ip) ?? []), Date.now()]);
  allFails.push(Date.now());
  if (failsByIp.size > 1000) failsByIp.clear(); // bounded memory under a spray
}
const DAY_AR = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const DAYS_MAP = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, 'الأحد': 0, 'الاحد': 0, 'الإثنين': 1, 'الاثنين': 1, 'الثلاثاء': 2, 'الأربعاء': 3, 'الاربعاء': 3, 'الخميس': 4, 'الجمعة': 5, 'السبت': 6 };
const parseDaysStr = str => String(str ?? '').toLowerCase().split(',').map(d => DAYS_MAP[d.trim()]).filter(d => d !== undefined);
const cadenceText = tpl => !tpl ? '—'
  : tpl.mode === 'daily' ? 'يومياً'
  : tpl.mode === 'interval' ? (tpl.everyN === 2 ? 'كل يومين' : `كل ${tpl.everyN} أيام`)
  : tpl.days.map(d => DAY_AR[d]).join('،');
// {mode, days?, everyN?, time?} from a JSON body (days may be a name string or int array)
function cadenceFromBody(b) {
  const time = String(b.time ?? '');
  if (b.mode === 'daily') return { mode: 'daily', time };
  if (b.mode === 'interval') return { mode: 'interval', everyN: Number(b.everyN), time };
  const days = Array.isArray(b.days) ? b.days.map(Number) : parseDaysStr(b.days);
  return { mode: 'days', days, time };
}

function memberTimeline(userId) {
  const db = getDb();
  const items = [];
  for (const p of db.prepare(
    'SELECT p.completed_at at, l.title FROM progress p JOIN lessons l ON l.id = p.lesson_id WHERE p.user_id = ?').all(userId)) {
    items.push({ at: p.at, ico: '✅', title: 'أكمل درساً', sub: p.title });
  }
  for (const a of db.prepare(
    "SELECT a.joined_at at, a.minutes, l.title FROM attendance a JOIN sessions s ON s.id = a.session_id JOIN lessons l ON l.id = s.lesson_id WHERE a.user_id = ?").all(userId)) {
    items.push({ at: a.at, ico: '🔊', title: 'حضر حصة', sub: `${a.title} (${a.minutes ?? 1} دقيقة)` });
  }
  for (const q of db.prepare(
    'SELECT qc.completed_at at, q.title FROM quest_completions qc JOIN quests q ON q.id = qc.quest_id WHERE qc.user_id = ?').all(userId)) {
    items.push({ at: q.at, ico: '🏅', title: 'إنجاز', sub: q.title });
  }
  return items.sort((x, y) => new Date(y.at) - new Date(x.at));
}

export function startWeb({ client = null, bus }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1); // real client IP behind the host's HTTPS proxy
  if (config.dashPassword && config.dashPassword.length < 12) {
    console.log('[web] WARNING: DASH_PASSWORD is shorter than 12 characters — use a long one when the dashboard is public');
  }
  app.use((_req, res, next) => {
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => {
    req.cookies = Object.fromEntries((req.headers.cookie ?? '').split(';').map(c => {
      const i = c.indexOf('=');
      try { return [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())]; } catch { return []; }
    }).filter(a => a[0]));
    next();
  });
  const hasDash = req => validSession(req.cookies?.dash);
  const dashAuth = (req, res, next) => (hasDash(req) ? next() : res.status(401).json({ error: 'غير مصرح' }));

  // ---------- SPA dash API (cookie) ----------
  app.get('/api/dash/data', dashAuth, async (req, res) => {
    const s = allSettings();
    let channelName = id => {
      if (!id || !client) return '';
      try { return client.channels.cache.get(id)?.name ?? ''; } catch { return ''; }
    };
    const lessons = A.listLessons().map(l => ({
      ...l, done: l.status === 'done',
      session: A.sessionForLesson(l.id) ?? null,
      parts: A.lessonParts(l).parts,
      video_sec: l.video_duration_sec ?? null,
    }));
    const sessPart = s => { const p = A.sessionPartInfo(s); return { part: p.part, parts: p.parts, from_min: p.fromMin, to_min: p.toMin }; };
    const engagement = A.memberEngagement();
    const participants = A.listParticipants().map(p => {
      const xp = A.xpTotal(p.user_id);
      const tl = memberTimeline(p.user_id);
      return {
        user_id: p.user_id, name: p.display_name || p.user_id, xp,
        level: A.levelFor(xp), streak: A.currentStreak(p.user_id),
        lessons_done: A.listProgress(p.user_id).length,
        dms_enabled: !!p.dms_enabled, last_activity: tl[0]?.at ?? null,
        engagement: engagement[p.user_id] ?? null,
      };
    });
    const tpl = normalizeTemplate(A.overview().template);
    const o = A.overview();
    const allSessions = A.listSessions({ future: true, limit: 200 });
    const courseOf = sid => {
      const s = allSessions.find(x => x.id === sid);
      return s ? A.getLesson(s.lesson_id)?.course_id ?? null : null;
    };
    const courses = A.listCourses().map(c => {
      const ls = A.listLessons(c.id);
      const next = o.courses.find(x => x.id === c.id)?.next_session ?? null;
      return {
        id: c.id, title: c.title, mode: c.template?.mode ?? null, time: c.time,
        everyN: c.every_n, daysText: cadenceText(c.template),
        lessons_total: ls.length,
        lessons_done: ls.filter(l => l.status === 'done').length,
        upcoming: allSessions.filter(s => courseOf(s.id) === c.id).length,
        next_session: next ? { ...next, lesson_title: A.getLesson(next.lesson_id)?.title } : null,
      };
    });
    const live = allSessions.find(x => x.status === 'live') ?? null;
    res.json({
      tz: config.tz,
      botOk: config.disableDiscord ? false : !!client?.isReady?.(),
      courses,
      lessons,
      sessions: A.listSessions({ future: true, limit: 50 }).map(x => ({
        ...x, lesson_title: A.getLesson(x.lesson_id)?.title,
        course_id: A.getLesson(x.lesson_id)?.course_id ?? null, ...sessPart(x) })),
      participants,
      quests: A.listQuests().map(q => ({ id: q.id, title: q.title, category: q.category, done: A.questCompletionCount(q.id) })),
      books: A.bookStats(),
      groups: A.listGroups().map(g => A.groupRoster(g.id)),
      questions: A.listQuestions().map(q => ({
        id: q.id, course_id: q.course_id, lesson_id: q.lesson_id, question: q.question,
        options: q.options, correct_index: q.correct_index, xp: q.xp,
        answers: getDb().prepare('SELECT COUNT(*) AS c FROM question_answers WHERE question_id = ?').get(q.id).c,
      })),
      settings: { ...s, tz: s.tz || config.tz, channel_dashboard_name: channelName(s.channel_dashboard), study_vc_name: channelName(s.study_vc) },
      overview: { lessonsDone: o.lessons_done, lessonsTotal: o.lessons_total },
      template: tpl ? { ...tpl, daysText: cadenceText(tpl) } : null,
      live: live ? {
        id: live.id, lesson_title: A.getLesson(live.lesson_id)?.title,
        scheduled_at: live.scheduled_at, attendees: A.sessionAttendance(live.id).length,
        // who is in the room right now (joined, not yet left)
        present: A.sessionAttendance(live.id).filter(a => !a.left_at)
          .map(a => A.getParticipant(a.user_id)?.display_name || a.user_id),
        ...sessPart(live),
      } : null,
      nextSession: o.next_session,
    });
  });

  app.get('/api/dash/member/:id', dashAuth, (req, res) => {
    const p = A.getParticipant(req.params.id);
    if (!p) return res.status(404).json({ error: 'العضو غير موجود' });
    const xp = A.xpTotal(p.user_id);
    res.json({
      user_id: p.user_id, name: p.display_name || p.user_id, xp,
      level: A.levelFor(xp), streak: A.currentStreak(p.user_id),
      lessons_done: A.listProgress(p.user_id).length,
      dms_enabled: !!p.dms_enabled,
      courses: A.listCourses().map(c => {
        const cp = A.courseProgress(c.id, p.user_id);
        return {
          id: c.id, title: c.title, done: cp.done, total: cp.total,
          next: cp.next ? { title: cp.next.title } : null,
          items: cp.items,
        };
      }),
      books: A.bookShelf(p.user_id).filter(b => b.page > 0 || b.finished),
      timeline: memberTimeline(p.user_id),
    });
  });

  // every member's standing in one course (checklist roster)
  app.get('/api/dash/course/:id/progress', dashAuth, (req, res) => {
    if (!A.getCourse(+req.params.id)) return res.status(404).json({ error: 'الدورة غير موجودة' });
    res.json({ roster: A.courseRoster(+req.params.id) });
  });

  const ok = (res, message) => res.json({ ok: true, message });

  app.post('/api/dash/lesson/add', dashAuth, async (req, res) => {
    const { title, url = '', durationMin = 60, courseId = null } = req.body ?? {};
    if (!title?.trim()) return res.status(400).json({ error: 'العنوان مطلوب' });
    // best effort: read the real video length so long videos auto-split
    let videoId = null, videoSec = null;
    if (url.trim()) {
      try { const meta = await fetchVideoMeta(url.trim()); videoId = meta.videoId; videoSec = meta.durationSec; } catch {}
    }
    A.addLesson({ title: title.trim(), url: url.trim(), durationMin: +durationMin || 60, videoId, videoDurationSec: videoSec, courseId: courseId ?? null });
    const parts = videoSec ? Math.ceil(videoSec / (Math.max(10, +durationMin || 60) * 60)) : 1;
    ok(res, videoSec
      ? `أُضيف الدرس — طوله ${Math.round(videoSec / 60)} دقيقة${parts > 1 ? ` ويُقسَّم تلقائياً إلى ${parts} حصص` : ''} ✓`
      : 'أُضيف الدرس ✓');
  });

  // ---------- courses: each with its own lessons + its own cadence ----------
  app.post('/api/dash/course/add', dashAuth, async (req, res) => {
    const b = req.body ?? {};
    if (!b.title?.trim()) return res.status(400).json({ error: 'اكتب عنوان الدورة' });
    let id;
    try { id = A.createCourse({ title: b.title.trim(), ...cadenceFromBody(b) }); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    let added = 0, skipped = 0;
    if (/^https?:\/\//i.test(String(b.playlistUrl ?? '').trim())) {
      try {
        const { learnerPing, syncCourseCards } = await import('./coursereg.js');
        const pl = await fetchPlaylist(String(b.playlistUrl).trim());
        const imp = A.importPlaylist(pl.entries, { durationMin: Math.max(10, +b.durationMin || 60), courseId: id });
        added = imp.added.length; skipped = imp.skipped;
        if (added && client) {
          const ch = await client.channels.fetch(getSetting('channel_dashboard')).catch(() => null);
          if (ch) await ch.send(`${learnerPing()} 🎓 دورة جديدة **«${b.title.trim()}»** — أُضيف **${added}** درساً من قائمة «${pl.title ?? 'التشغيل'}»${skipped ? ` (${skipped} موجود مسبقاً)` : ''}.
للاشتراك بتنبيهاتها: قناة **📊 لوحة الأكاديمية**`).catch(() => null);
          syncCourseCards(client).catch(() => {});
        }
      } catch (e) {
        return ok(res, `أُنشئت الدورة «${b.title.trim()}» لكن تعذّر استيراد القائمة: ${e.message}`);
      }
    }
    if (!added && client) {
      const { learnerPing, syncCourseCards } = await import('./coursereg.js');
      const ch = await client.channels.fetch(getSetting('channel_dashboard')).catch(() => null);
      if (ch) await ch.send(`${learnerPing()} 🎓 دورة جديدة **«${b.title.trim()}»** في الأكاديمية.\nللاشتراك بتنبيهاتها: قناة **📊 لوحة الأكاديمية**`).catch(() => null);
      syncCourseCards(client).catch(() => {});
    }
    let scheduled = 0;
    if (b.generate !== false) {
      try { scheduled = A.generateScheduleForCourse(id, {}).length; } catch {}
    }
    ok(res, `أُنشئت الدورة «${b.title.trim()}»${added ? ` مع ${added} درساً` : ''}${scheduled ? ` وجُدولت ${scheduled} حصة` : ''} ✓`);
  });

  app.post('/api/dash/course/update', dashAuth, (req, res) => {
    const b = req.body ?? {};
    if (!b.id) return res.status(400).json({ error: 'أي دورة؟ (id)' });
    const patch = {};
    if (b.title != null) patch.title = b.title;
    if (b.mode != null) Object.assign(patch, cadenceFromBody(b));
    else if (b.days != null || b.everyN != null || b.time != null) Object.assign(patch, cadenceFromBody({ ...b, mode: b.mode ?? 'days' }));
    try {
      if (!A.updateCourse(+b.id, patch)) return res.status(404).json({ error: 'الدورة غير موجودة' });
    } catch (e) { return res.status(400).json({ error: e.message }); }
    ok(res, 'حُفظ ✓');
  });

  app.post('/api/dash/course/remove', dashAuth, (req, res) => {
    try {
      if (!A.removeCourse(+(req.body?.id))) return res.status(404).json({ error: 'الدورة غير موجودة' });
    } catch (e) { return res.status(400).json({ error: e.message }); }
    stopStream();
    ok(res, 'حُذفت الدورة بدروسها ومواعيدها ✓');
  });

  app.post('/api/dash/course/generate', dashAuth, async (req, res) => {
    try {
      const created = A.generateScheduleForCourse(+(req.body?.id), {});
      ok(res, created.length ? `جُدولت ${created.length} حصة للدورة ✓` : 'لا شيء جديد للجدولة — أضف دروساً أو كل الدروس لها حصص بالفعل');
    } catch (e) { res.status(400).json({ error: e.message }); }
  });

  // YouTube playlist -> ordered lessons of one course (deduped), real durations
  app.post('/api/dash/playlist/import', dashAuth, async (req, res) => {
    const { url, durationMin = 60, courseId = null } = req.body ?? {};
    if (!/^https?:\/\//i.test(String(url ?? '').trim()))
      return res.status(400).json({ error: 'الصق رابط قائمة تشغيل يوتيوب صالحاً' });
    try {
      const pl = await fetchPlaylist(String(url).trim());
      const { added, skipped } = A.importPlaylist(pl.entries, { durationMin: Math.max(10, +durationMin || 60), courseId: courseId ?? null });
      if (added.length && client) {
        const ch = await client.channels.fetch(getSetting('channel_dashboard')).catch(() => null);
        if (ch) await ch.send(`📚 أُضيف **${added.length}** درساً جديداً من قائمة «${pl.title ?? 'التشغيل'}»${skipped ? ` (${skipped} موجود مسبقاً)` : ''}.`)
          .catch(() => null);
      }
      ok(res, `أُضيف ${added.length} درساً من القائمة${skipped ? ` وتُجاهل ${skipped} موجوداً مسبقاً` : ''} — «جدولة تلقائية» توزّعها الآن ✓`);
    } catch (e) {
      res.status(502).json({ error: 'تعذّر قراءة القائمة: ' + (e.message || 'خطأ غير متوقع') });
    }
  });
  app.post('/api/dash/lesson/update', dashAuth, async (req, res) => {
    const { id, title, url, durationMin } = req.body ?? {};
    const l = A.getLesson(+id);
    if (!l) return res.status(404).json({ error: 'الدرس غير موجود' });
    getDb().prepare('UPDATE lessons SET title = ?, url = ?, duration_min = ? WHERE id = ?')
      .run(title?.trim() || l.title, url?.trim() ?? l.url, +durationMin || l.duration_min, +id);
    ok(res, 'حُفظ التعديل ✓');
  });
  app.post('/api/dash/lesson/remove', dashAuth, (req, res) => {
    A.removeLesson(+(req.body?.id));
    ok(res, 'حُذف الدرس ✓');
  });
  app.post('/api/dash/lesson/move', dashAuth, (req, res) => {
    const { id, dir } = req.body ?? {};
    const l = A.getLesson(+id);
    if (!l) return res.status(404).json({ error: 'الدرس غير موجود' });
    // reorder inside the lesson's own course only
    const ids = A.listLessons(l.course_id).map(x => x.id);
    const i = ids.indexOf(+id); const j = i + (+dir);
    if (i >= 0 && j >= 0 && j < ids.length) { [ids[i], ids[j]] = [ids[j], ids[i]]; A.reorder(ids); }
    ok(res, 'تم الترتيب ✓');
  });
  app.post('/api/dash/session/move', dashAuth, (req, res) => {
    const { id, date, time } = req.body ?? {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '') || !/^\d{2}:\d{2}$/.test(time ?? ''))
      return res.status(400).json({ error: 'تاريخ أو وقت غير صالح' });
    A.setSession(+id, zonedToUtc(date, time, config.tz).toISOString());
    ok(res, 'نُقلت الحصة ✓');
  });
  app.post('/api/dash/session/cancel', dashAuth, (req, res) => {
    A.cancelSession(+(req.body?.id)); stopStream();
    ok(res, 'أُلغيت الحصة ✓');
  });
  app.post('/api/dash/template', dashAuth, (req, res) => {
    // legacy single-course endpoint — applies to the FIRST course
    const first = A.listCourses()[0];
    if (!first) return res.status(404).json({ error: 'لا توجد دورات' });
    try {
      A.updateCourse(first.id, cadenceFromBody(req.body ?? {}));
    } catch (e) { return res.status(400).json({ error: 'إعدادات غير صالحة — الأيام/التكرار/الوقت (مثال: الأحد,الأربعاء + 20:00)' }); }
    const course = A.getCourse(first.id); // reflects the new cadence
    if (course.template) A.setTemplate(course.template); // keep the legacy global setting in sync
    ok(res, 'حُفظ الإيقاع ✓');
  });
  app.post('/api/dash/generate', dashAuth, async (req, res) => {
    try {
      const created = A.generateSchedule({});
      ok(res, created.length ? `جُدولت ${created.length} حصة ✓` : 'كل الدروس لها حصص بالفعل');
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/dash/quest/add', dashAuth, async (req, res) => {
    const { title, category = 'lecture' } = req.body ?? {};
    const KIND = { book: 'كتاب جديد', lecture: 'محاضرة جديدة', course: 'دورة جديدة' };
    if (!title?.trim() || !KIND[category]) return res.status(400).json({ error: 'أكمل العنوان واختر الفئة' });
    const id = A.createQuest({ title: title.trim(), category });
    const chId = getSetting('channel_dashboard');
    if (chId && client) {
      const ch = await client.channels.fetch(chId).catch(() => null);
      if (ch) await ch.send({
        content: templates.quest_new
          .replace('{{kind}}', KIND[category])
          .replace('{{title}}', title.trim()),
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`quest:check:${id}`).setLabel('أنجزتها ✅').setStyle(ButtonStyle.Success),
        )],
      }).catch(() => null);
    }
    ok(res, 'أُضيف إلى قائمة الإنجاز وأُعلن في الديسكورد ✓');
  });
  app.post('/api/dash/quest/end', dashAuth, (req, res) => {
    A.endQuest(+(req.body?.id));
    ok(res, 'أُزيل من قائمة الإنجاز ✓');
  });
  const ALLOWED_SETTINGS = ['tz', 'nudge_hour', 'nudge_over_dm', 'nudge_cooldown_hours', 'recap_day', 'recap_hour', 'reminder_minutes_before', 'missed_after_minutes', 'backup_hour', 'cache_max_mb'];
  app.post('/api/dash/settings', dashAuth, (req, res) => {
    for (const [k, v] of Object.entries(req.body ?? {})) if (ALLOWED_SETTINGS.includes(k) && v !== '') setSetting(k, v);
    ok(res, 'حُفظت الإعدادات ✓');
  });

  // ---------- system: backups, restore, cookies (no SFTP needed on container hosts) ----------
  app.get('/api/dash/system', dashAuth, (_req, res) => res.json(systemStatus()));
  app.post('/api/dash/system/cookies', dashAuth, express.text({ type: '*/*', limit: '2mb' }), (req, res) => {
    const r = saveCookies(typeof req.body === 'string' ? req.body : '');
    if (!r.ok) return res.status(400).json({ error: r.error });
    res.json({ ok: true, message: `حُفظ ملف الكوكيز (${r.count} سطراً) — يُستخدم من الحصة القادمة ✓` });
  });
  app.post('/api/dash/system/restore', dashAuth, express.raw({ type: '*/*', limit: '80mb' }), async (req, res) => {
    if (A.listSessions({ future: true }).some(s => s.status === 'live')) {
      return res.status(409).json({ error: 'توجد حصة مباشرة — أنهِها قبل استعادة قاعدة البيانات.' });
    }
    const r = restoreDatabase(Buffer.isBuffer(req.body) ? req.body : null);
    if (!r.ok) return res.status(400).json({ error: r.error });
    // the restored data has its own courses/members — redraw everything from it
    markAllMembersDirty();
    if (client?.isReady?.()) {
      syncCourseCards(client).catch(e => console.log('[web] restore: course cards', e.message));
      syncLibrary(client).catch(e => console.log('[web] restore: library', e.message));
      refreshAcademyDashboard(client, { force: true }).catch(() => {});
    }
    res.json({ ok: true, message: `استُعيدت قاعدة البيانات: ${r.lessons} درس · ${r.members} عضو ✓ (النسخة السابقة محفوظة)` });
  });
  app.get('/api/dash/system/backup', dashAuth, (_req, res) => {
    try {
      const path = makeBackup(`manual-${new Date().toISOString().slice(0, 10)}`);
      res.download(path, `academy-${new Date().toISOString().slice(0, 10)}.db`);
    } catch (e) { res.status(500).json({ error: `تعذّر إنشاء النسخة: ${e.message}` }); }
  });

  app.post('/api/dash/action/start', dashAuth, async (req, res) => {
    const r = await startSessionNow({ client, bus, lessonId: Number(req.body?.lessonId) });
    if (!r.ok) return res.status(409).json({ error: r.error });
    ok(res, 'بدأت الحصة — المدرب في الغرفة ✓');
  });
  app.post('/api/dash/action/finish', dashAuth, async (req, res) => {
    const live = A.listSessions({ future: true }).find(x => x.status === 'live');
    if (!live) return res.status(409).json({ error: 'لا توجد حصة مباشرة' });
    const r = await finishSession({ client, bus, sessionId: live.id });
    ok(res, r ? 'انتهت الحصة وصُرفت النقاط ✓' : 'تعذر الإنهاء');
  });

  // ---------- live player control (pause / seek / volume) ----------
  app.get('/api/dash/player', dashAuth, (_req, res) => res.json(playerState()));
  app.post('/api/dash/player', dashAuth, (req, res) => {
    const { op, delta, value } = req.body ?? {};
    const r = controlPlayer(op, { delta, value });
    if (!r.ok) return res.status(409).json({ error: r.error });
    res.json({ ok: true, player: playerState() });
  });

  // ---------- books & reading groups ----------
  app.post('/api/dash/book/add', dashAuth, (req, res) => {
    const { title, totalPages } = req.body ?? {};
    if (!title?.trim()) return res.status(400).json({ error: 'اكتب عنوان الكتاب' });
    const id = A.addBook({ title: title.trim(), totalPages: +totalPages || 100 });
    publishBook(client, A.getBook(id)).catch(() => {}); // card in the library channel
    ok(res, 'أُضيف الكتاب ونُشر في المكتبة ✓');
  });
  app.post('/api/dash/book/remove', dashAuth, (req, res) => {
    const id = +(req.body?.id);
    if (!A.removeBook(id)) return res.status(404).json({ error: 'الكتاب غير موجود' });
    unpublishBook(client, id).catch(() => {});
    ok(res, 'حُذف الكتاب (ومجموعاته وبطاقته في المكتبة) ✓');
  });
  app.post('/api/dash/group/add', dashAuth, async (req, res) => {
    const { title, bookId } = req.body ?? {};
    let gid;
    try { gid = A.createGroup({ title, bookId: +bookId }); }
    catch (e) { return res.status(400).json({ error: e.message }); }
    const g = A.getGroup(gid);
    if (client) {
      const ch = await client.channels.fetch(getSetting('channel_dashboard')).catch(() => null);
      if (ch) await ch.send({
        content: (await import('./coursereg.js')).learnerPing() + ' '+ templates.group_new
          .replace('{{title}}', g.title).replace('{{pages}}', String(g.total_pages)),
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`grp:join:${gid}`).setLabel('📖 أنضم').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(`grp:page:${gid}`).setLabel('📝 سجّل صفحتك').setStyle(ButtonStyle.Secondary),
        )],
      }).catch(() => null);
    }
    ok(res, `أُنشئت مجموعة «${g.title}» وأُعلن في الديسكورد ✓`);
  });
  app.post('/api/dash/group/end', dashAuth, (req, res) => {
    const g = A.getGroup(+(req.body?.id));
    if (!g) return res.status(404).json({ error: 'المجموعة غير موجودة' });
    A.endGroup(g.id);
    ok(res, `أُنهيت مجموعة «${g.title}» ✓`);
  });

  // ---------- member management ----------
  app.post('/api/dash/member/rename', dashAuth, (req, res) => {
    const { id, name } = req.body ?? {};
    if (!id || !name?.trim()) return res.status(400).json({ error: 'الاسم مطلوب' });
    const p = A.renameParticipant(String(id), name);
    if (!p) return res.status(404).json({ error: 'العضو غير موجود' });
    ok(res, `سُمّي «${p.display_name}» ✓`);
  });
  app.post('/api/dash/member/remove', dashAuth, async (req, res) => {
    const id = String(req.body?.id ?? '');
    const chId = A.getParticipant(id)?.private_channel_id ?? null;
    const gone = A.removeMember(id);
    if (!gone) return res.status(404).json({ error: 'العضو غير موجود' });
    if (chId && client) {
      const ch = await client.channels.fetch(chId).catch(() => null);
      if (ch) await ch.delete('member removed').catch(() => null);
    }
    ok(res, `حُذف «${gone.display_name || id}» بكل سجلاته ✓`);
  });

  // ---------- quiz questions ----------
  app.post('/api/dash/question/add', dashAuth, (req, res) => {
    const b = req.body ?? {};
    try {
      const id = A.addQuestion({
        courseId: +b.courseId, lessonId: b.lessonId ? +b.lessonId : null,
        question: b.question, options: b.options, correctIndex: +b.correctIndex, xp: +b.xp || 10,
      });
      ok(res, `أُضيف السؤال #${id} ✓`);
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/dash/question/remove', dashAuth, (req, res) => {
    if (!A.removeQuestion(+(req.body?.id))) return res.status(404).json({ error: 'السؤال غير موجود' });
    ok(res, 'حُذف السؤال ✓');
  });
  app.post('/api/dash/question/send', dashAuth, async (req, res) => {
    const q = A.getQuestion(+(req.body?.id));
    if (!q) return res.status(404).json({ error: 'السؤال غير موجود' });
    if (client) {
      const ch = await client.channels.fetch(getSetting('channel_dashboard')).catch(() => null);
      if (ch) {
        const LETTERS = ['🇦', '🇧', '🇨', '🇩', '🇪'];
        await ch.send({
          content: `❓ **${q.question}**\n_كن أول من يجيب إجابة صحيحة_`,
          components: [new ActionRowBuilder().addComponents(
            q.options.slice(0, 5).map((o, i) =>
              new ButtonBuilder().setCustomId(`quiz:${q.id}:${i}`).setLabel(o.slice(0, 80)).setStyle(ButtonStyle.Secondary)),
          )],
        }).catch(() => null);
      }
    }
    ok(res, 'أُرسل السؤال في الديسكورد ✓');
  });

  // ---------- auth + static ----------
  const loginPage = (msg = '') => `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>هُدَى · لوحة الأكاديمية</title>
<link rel="icon" href="/logo-mark.png">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Tajawal:wght@400;500;700;800&display=swap" rel="stylesheet">
<style>body{font-family:Tajawal,'Segoe UI',sans-serif;background:linear-gradient(165deg,#24468B 0%,#1E3A6E 45%,#152A52 100%);display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.c{background:#fff;border:1px solid #E3E8F0;border-radius:18px;padding:30px 30px 30px;width:min(380px,90vw);box-shadow:0 24px 60px rgba(8,18,42,.4);text-align:center}
.em{display:block;width:150px;height:auto;margin:0 auto 4px;border-radius:18px;border:1px solid #E9DFC2;box-shadow:0 10px 26px rgba(22,41,79,.10)}
.tag{color:#8B98AF;font-size:12px;letter-spacing:2px;margin-bottom:20px}
.s{color:#5B6B87;font-size:14px;margin-bottom:16px}
input{width:100%;box-sizing:border-box;background:#fff;color:#22314E;border:1px solid #CBD4E2;border-radius:10px;padding:12px;font-size:16px;text-align:center;outline:none;transition:border-color .15s,box-shadow .15s}
input:focus{border-color:#C9992E;box-shadow:0 0 0 3px rgba(201,153,46,.14)}
button{width:100%;margin-top:14px;background:#C9992E;color:#16294F;border:none;border-radius:10px;padding:13px;font-size:16px;font-weight:700;cursor:pointer;font-family:inherit;transition:background .15s}
button:hover{background:#DBAF41}
.err{color:#B3261E;font-size:14px;margin-top:12px}</style></head>
<body><form class="c" method="post" action="/login">
<img class="em" src="/logo.png" alt="هُدَى">
<div class="tag">منصّة دعوية</div><div class="s">تسجيل الدخول إلى لوحة الأكاديمية</div>
<input type="password" name="password" placeholder="كلمة المرور" autofocus><button>دخول</button>${msg ? `<div class="err">${msg}</div>` : ''}</form></body></html>`;
  // Secure only over HTTPS (bot-hosting.net subdomain) — the LAN/tablet dashboard is plain http
  const isHttps = req => req.secure || req.headers['x-forwarded-proto'] === 'https';
  const cookie = (req, value, maxAgeSec) =>
    `dash=${value}; HttpOnly; Path=/; Max-Age=${maxAgeSec}; SameSite=Lax${isHttps(req) ? '; Secure' : ''}`;
  app.get('/login', (_req, res) => res.send(loginPage()));
  app.post('/login', (req, res) => {
    const ip = req.ip ?? 'unknown';
    if (loginBlocked(ip)) return res.status(429).send(loginPage('محاولات كثيرة — انتظر ربع ساعة ثم حاول مجدداً.'));
    if (sameSecret(req.body?.password, config.dashPassword)) {
      failsByIp.delete(ip);
      res.setHeader('Set-Cookie', cookie(req, createSession(), SESSION_MS / 1000));
      return res.redirect('/');
    }
    noteLoginFailure(ip);
    console.log(`[web] failed dashboard login from ${ip}`);
    res.status(401).send(loginPage('كلمة المرور غير صحيحة.'));
  });
  app.get('/logout', (req, res) => {
    revokeSession(req.cookies?.dash);
    res.setHeader('Set-Cookie', cookie(req, '', 0));
    res.redirect('/login');
  });

  // ---------- static: any frontend dropped into public/ (user-built dashboard) ----------
  // index: false so "/" always goes through the session check below
  app.use(express.static(join(here, '../../public'), { index: false }));
  app.get('/', (req, res, next) => {
    const index = join(here, '../../public/index.html');
    if (hasDash(req) && existsSync(index)) return res.sendFile(index);
    if (existsSync(index)) return res.redirect('/login');
    res.status(204).end(); // no UI installed yet — API only
  });

  return app.listen(config.port, '0.0.0.0', () => console.log(`[coach] dashboard+api on :${config.port}`));
}
