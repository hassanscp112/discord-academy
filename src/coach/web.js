// Coach web server: Arabic SPA (public/) + cookie-auth dashboard API
// + token-auth API for the AI Admin studio. Old HTML pages are gone.
import express from 'express';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as A from '../core/academy.js';
import { getSetting, setSetting, allSettings, getDb } from '../core/db.js';
import { fmtInTz, zonedToUtc } from '../core/time.js';
import { config } from '../core/config.js';
import { applyPublish, currentRevision } from './publish.js';
import { refreshDashboard, markDashboardDirty } from './dashboard.js';
import { stopStream } from './streamer.js';
import { startSessionNow, finishSession } from './sessions.js';
import { templates } from '../core/templates.js';

const here = dirname(fileURLToPath(import.meta.url));
const dashCookie = () => createHash('sha256').update(`academy:${config.dashPassword}`).digest('hex').slice(0, 32);
const DAY_AR = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];

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
    items.push({ at: q.at, ico: '🏅', title: 'أنجز مهمة', sub: q.title });
  }
  return items.sort((x, y) => new Date(y.at) - new Date(x.at));
}

export function startWeb({ client = null, bus }) {
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json({ limit: '1mb' }));
  app.use((req, _res, next) => {
    req.cookies = Object.fromEntries((req.headers.cookie ?? '').split(';').map(c => c.trim().split('=').map(decodeURIComponent)).filter(a => a[0]));
    next();
  });
  const hasDash = req => req.cookies?.dash === dashCookie();
  const dashAuth = (req, res, next) => (hasDash(req) ? next() : res.status(401).json({ error: 'غير مصرح' }));

  // ---------- token API (AI studio) ----------
  const apiAuth = (req, res, next) => {
    if ((req.headers['x-api-token'] ?? '') !== config.apiToken) return res.status(401).json({ error: 'bad token' });
    next();
  };
  app.get('/api/state', apiAuth, (_req, res) => {
    res.json({
      revision: currentRevision(), tz: config.tz, overview: A.overview(), lessons: A.listLessons(),
      sessions: A.listSessions({ future: true, limit: 200 }).map(s => ({ ...s, lesson_title: A.getLesson(s.lesson_id)?.title })),
      participants: A.listParticipants().map(p => ({
        ...p, xp: A.xpTotal(p.user_id), level: A.levelFor(A.xpTotal(p.user_id)),
        streak: A.currentStreak(p.user_id), lessons_done: A.listProgress(p.user_id).length,
      })),
      quests: A.listQuests({ activeOnly: false }), settings: allSettings(),
    });
  });
  app.post('/api/publish', apiAuth, (req, res) => {
    const result = applyPublish(req.body ?? {});
    if (!result.ok) return res.status(result.code).json({ error: result.error, revision: result.revision });
    markDashboardDirty();
    refreshDashboard(client, { force: true }).finally(() => {
      if (result.announce && bus) bus.postTo('channel_dashboard', { content: String(result.announce).slice(0, 1800) });
      res.json({ ok: true, revision: result.revision, applied: result.applied });
    });
  });

  // ---------- SPA dash API (cookie) ----------
  app.get('/api/dash/data', dashAuth, async (req, res) => {
    const s = allSettings();
    let channelName = id => {
      if (!id || !client) return '';
      try { return client.channels.cache.get(id)?.name ?? ''; } catch { return ''; }
    };
    const lessons = A.listLessons().map(l => ({ ...l, done: l.status === 'done', session: A.sessionForLesson(l.id) ?? null }));
    const participants = A.listParticipants().map(p => {
      const xp = A.xpTotal(p.user_id);
      const tl = memberTimeline(p.user_id);
      return {
        user_id: p.user_id, name: p.display_name || p.user_id, xp,
        level: A.levelFor(xp), streak: A.currentStreak(p.user_id),
        lessons_done: A.listProgress(p.user_id).length,
        dms_enabled: !!p.dms_enabled, last_activity: tl[0]?.at ?? null,
      };
    });
    const tpl = A.overview().template;
    const o = A.overview();
    const live = A.listSessions({ future: true }).find(x => x.status === 'live') ?? null;
    res.json({
      tz: config.tz,
      botOk: config.disableDiscord ? false : !!client?.isReady?.(),
      lessons,
      sessions: A.listSessions({ future: true, limit: 50 }).map(x => ({ ...x, lesson_title: A.getLesson(x.lesson_id)?.title })),
      participants, quests: A.listQuests({ activeOnly: false }),
      settings: { ...s, channel_dashboard_name: channelName(s.channel_dashboard), study_vc_name: channelName(s.study_vc) },
      overview: { lessonsDone: o.lessons_done, lessonsTotal: o.lessons_total },
      template: tpl ? { ...tpl, daysText: tpl.days.map(d => DAY_AR[d]).join(',') } : null,
      live: live ? {
        id: live.id, lesson_title: A.getLesson(live.lesson_id)?.title,
        scheduled_at: live.scheduled_at, attendees: A.sessionAttendance(live.id).length,
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
      timeline: memberTimeline(p.user_id),
    });
  });

  const ok = (res, message) => { markDashboardDirty(); refreshDashboard(client, { force: true }).catch(() => {}); return res.json({ ok: true, message }); };

  app.post('/api/dash/lesson/add', dashAuth, async (req, res) => {
    const { title, url = '', durationMin = 60 } = req.body ?? {};
    if (!title?.trim()) return res.status(400).json({ error: 'العنوان مطلوب' });
    A.addLesson({ title: title.trim(), url: url.trim(), durationMin: +durationMin || 60 });
    ok(res, 'أُضيف الدرس ✓');
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
    const ids = A.listLessons().map(x => x.id);
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
    const map = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, 'الأحد': 0, 'الاحد': 0, 'الإثنين': 1, 'الاثنين': 1, 'الثلاثاء': 2, 'الأربعاء': 3, 'الاربعاء': 3, 'الخميس': 4, 'الجمعة': 5, 'السبت': 6 };
    const days = String(req.body?.days ?? '').toLowerCase().split(',').map(d => map[d.trim()]).filter(d => d !== undefined);
    const time = String(req.body?.time ?? '');
    if (!days.length || !/^\d{2}:\d{2}$/.test(time)) return res.status(400).json({ error: 'أيام أو وقت غير صالح (مثال: الأحد,الأربعاء + 20:00)' });
    A.setTemplate({ days, time });
    ok(res, 'حُفظ القالب ✓');
  });
  app.post('/api/dash/generate', dashAuth, async (req, res) => {
    try {
      const created = A.generateSchedule({});
      ok(res, created.length ? `جُدولت ${created.length} حصة ✓` : 'كل الدروس لها حصص بالفعل');
    } catch (e) { res.status(400).json({ error: e.message }); }
  });
  app.post('/api/dash/quest/add', dashAuth, async (req, res) => {
    const { title, lessonIds = [], ends } = req.body ?? {};
    if (!title?.trim() || !lessonIds.length || !/^\d{4}-\d{2}-\d{2}$/.test(ends ?? ''))
      return res.status(400).json({ error: 'أكمل الحقول (عنوان، دروس، تاريخ)' });
    A.createQuest({
      title: title.trim(), lessonIds: lessonIds.map(Number), startsAt: new Date().toISOString(),
      endsAt: zonedToUtc(ends, '23:59', config.tz).toISOString(),
    });
    const chId = getSetting('channel_dashboard');
    if (chId && client) {
      const ch = await client.channels.fetch(chId).catch(() => null);
      if (ch) await ch.send(templates.quest_new
        .replace('{{title}}', title.trim())
        .replace('{{description}}', `أكمل الدروس: ${lessonIds.map(id => A.getLesson(+id)?.title).filter(Boolean).join(' + ')}`)
        .replace('{{xp}}', String(getSetting('xp_quest', '150')))
        .replace('{{ends}}', ends)).catch(() => null);
    }
    ok(res, 'أُنشئت المهمة وأُعلنت في الديسكورد ✓');
  });
  app.post('/api/dash/quest/end', dashAuth, (req, res) => {
    A.endQuest(+(req.body?.id));
    ok(res, 'أُنهيت المهمة ✓');
  });
  const ALLOWED_SETTINGS = ['tz', 'xp_attendance', 'xp_completion', 'xp_quest', 'nudge_hour', 'nudge_over_dm', 'nudge_cooldown_hours', 'recap_day', 'recap_hour', 'reminder_minutes_before', 'missed_after_minutes', 'level_roles'];
  app.post('/api/dash/settings', dashAuth, (req, res) => {
    for (const [k, v] of Object.entries(req.body ?? {})) if (ALLOWED_SETTINGS.includes(k) && v !== '') setSetting(k, v);
    ok(res, 'حُفظت الإعدادات ✓');
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

  // ---------- auth + static ----------
  const loginPage = `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>الأكاديمية</title>
<style>body{font-family:Tajawal,'Segoe UI',sans-serif;background:#0b0e17;color:#e9ecf5;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.c{background:#151b2e;border:1px solid #232c4a;border-radius:16px;padding:30px;width:min(360px,90vw)}
h1{font-size:22px;margin-bottom:4px}.s{color:#939dbd;font-size:14px;margin-bottom:18px}
input{width:100%;box-sizing:border-box;background:#0b0e17;color:#fff;border:1px solid #2e3a61;border-radius:10px;padding:12px;font-size:16px}
button{width:100%;margin-top:14px;background:#5865f2;color:#fff;border:none;border-radius:10px;padding:13px;font-size:16px;font-weight:700;cursor:pointer;font-family:inherit}</style></head>
<body><form class="c" method="post" action="/login"><h1>🎓 لوحة الأكاديمية</h1><div class="s">تسجيل الدخول</div>
<input type="password" name="password" placeholder="كلمة المرور" autofocus><button>دخول</button></form></body></html>`;
  app.get('/login', (_req, res) => res.send(loginPage));
  app.post('/login', (req, res) => {
    if (req.body.password === config.dashPassword) {
      res.setHeader('Set-Cookie', `dash=${dashCookie()}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax`);
      return res.redirect('/');
    }
    res.status(401).send(loginPage);
  });
  app.get('/logout', (_req, res) => { res.setHeader('Set-Cookie', 'dash=; Max-Age=0'); res.redirect('/login'); });

  // ---------- static: any frontend dropped into public/ (user-built dashboard) ----------
  app.use(express.static(join(here, '../../public')));
  app.get('/', (req, res, next) => {
    const index = join(here, '../../public/index.html');
    if (hasDash(req) && existsSync(index)) return res.sendFile(index);
    if (existsSync(index)) return res.redirect('/login');
    res.status(204).end(); // no UI installed yet — API only
  });

  return app.listen(config.port, '0.0.0.0', () => console.log(`[coach] dashboard+api on :${config.port}`));
}
