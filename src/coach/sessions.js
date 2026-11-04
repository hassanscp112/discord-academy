// Session state machine, driven by a 20s tick:
//   scheduled -> reminded (T-30m) -> live (T-0) -> done (T+duration, attendees > 0)
//   live -> missed_poll (T+15m, attendees == 0) -> auto-move 24h after the poll
import { ButtonBuilder, ButtonStyle, ActionRowBuilder } from 'discord.js';
import * as A from '../core/academy.js';
import { getDb, getSetting } from '../core/db.js';
import { nextSlots, fmtInTz, humanDuration } from '../core/time.js';
import { config } from '../core/config.js';
import { templates } from '../core/templates.js';
import { refreshDashboard, markDashboardDirty } from './dashboard.js';
import { startStream, stopStream, prefetch, playerState } from './streamer.js';
import { markMemberDirty, refreshMemberDashboards } from './memberdash.js';
import { refreshAcademyDashboard } from './acadashboard.js';

const run = (sql, ...p) => getDb().prepare(sql).run(...p);
const fill = (text, vars) => text.replace(/\{\{(\w+)\}\}/g, (_, k) => vars?.[k] ?? '');
const urlLine = url => (url ? `▶️ ${url}` : '');
const subBtn = lesson => new ButtonBuilder().setCustomId(`csub:${lesson.course_id}`).setLabel('🔔 اشترك بالدورة').setStyle(ButtonStyle.Primary);
const pingTag = () => { const r = getSetting('ping_role'); return r ? `<@&${r}>` : '@here'; };
// who to ping for a course: its opt-in subscribers, else the academy-wide role
function pingFor(lesson) {
  const course = lesson?.course_id ? A.getCourse(lesson.course_id) : null;
  if (course?.role_id) return `<@&${course.role_id}>`;
  const subs = lesson ? A.courseSubscribers(lesson.course_id) : [];
  if (subs.length) return subs.map(id => `<@${id}>`).join(' ');
  return pingTag();
}

// post a quiz question with answer buttons
async function postQuestion(bus, q) {
  const LETTERS = ['🇦', '🇧', '🇨', '🇩', '🇪'];
  await bus.postTo('channel_dashboard', {
    content: `❓ **${q.question}**\n_كن أول من يجيب إجابة صحيحة_`,
    components: [new ActionRowBuilder().addComponents(
      q.options.slice(0, 5).map((o, i) =>
        new ButtonBuilder().setCustomId(`quiz:${q.id}:${i}`).setLabel(o.slice(0, 80)).setStyle(ButtonStyle.Secondary)),
    )],
  });
}

// video position as a clock: 75 min -> "1:15:00", 9 min -> "9:00"
const clock = min => {
  const h = Math.floor(min / 60), m = Math.round(min % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:00` : `${m}:00`;
};

// "⏱️ الجزء 2 من 3 — من 1:00:00 إلى 2:00:00" for multi-part lessons, '' otherwise
function partLine(session) {
  const info = A.sessionPartInfo(session);
  if (info.parts < 2) return '';
  const range = info.toMin != null ? ` إلى ${clock(info.toMin)}` : '';
  return `\n⏱️ الجزء ${info.part} من ${info.parts} — من ${clock(info.fromMin)}${range}`;
}

// A restart mid-class (bot-hosting.net restarts pull new code) leaves the session
// 'live' with nothing playing — rejoin and continue from where the class should be.
// Retried at most every 2 min so a failing yt-dlp doesn't respawn every tick.
const resumeTried = new Map(); // sessionId -> last attempt ms
function resumeIfSilent(client, s, lesson, now) {
  if (!lesson.url || playerState().live) return;
  if (now - (resumeTried.get(s.id) ?? 0) < 120000) return;
  resumeTried.set(s.id, now.getTime());
  const intoClassSec = Math.max(0, (now - new Date(s.scheduled_at)) / 1000);
  const opts = streamOpts(s, lesson);
  const leftSec = opts.sessionLenSec - intoClassSec;
  if (leftSec < 60) return; // class is all but over — let it finish normally
  console.log(`[sessions] live class ${s.id} has no audio — resuming at +${Math.round(intoClassSec / 60)} min`);
  startStream(client, { ...opts, offsetSec: opts.offsetSec + intoClassSec, sessionLenSec: leftSec });
}

function streamOpts(session, lesson) {
  return {
    sessionId: session.id,
    lessonId: lesson.id,
    title: lesson.title,
    url: lesson.url,
    offsetSec: (session.offset_min || 0) * 60, // long videos: continue where the last class stopped
    durationSec: lesson.video_duration_sec ?? null,
    sessionLenSec: (lesson.duration_min || 60) * 60,
  };
}

function sessRow(session) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sess:move:${session.id}`).setLabel('👍 نعم انقلها').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`sess:slots:${session.id}`).setLabel('🗓️ وقت آخر').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`sess:skip:${session.id}`).setLabel('⏭️ تجاوز الدرس').setStyle(ButtonStyle.Danger),
  );
}

// Quests are now owner-managed checklist items (books/lectures/courses) —
// no auto-generation, no expiry.

// next free slot of the session's OWN course after `after` — proposal only
export function proposeSlot(after, session = null) {
  const lesson = session ? A.getLesson(session.lesson_id) : null;
  const tpl = lesson ? A.getCourse(lesson.course_id)?.template : null;
  if (!tpl) return new Date(after.getTime() + 7 * 86400000);
  const slots = nextSlots(tpl, after, 4, config.tz);
  const used = new Set(A.listSessions({ future: true }).map(x => x.scheduled_at));
  return slots.find(s => !used.has(s.toISOString())) ?? slots[0] ?? new Date(after.getTime() + 7 * 86400000);
}

export async function tick({ client = null, bus, now = new Date() } = {}) {
  const remMin = Number(getSetting('reminder_minutes_before', '30'));
  const missMin = Number(getSetting('missed_after_minutes', '15'));

  for (const s of A.listSessions({ future: true })) {
    const lesson = A.getLesson(s.lesson_id);
    if (!lesson) continue;
    const t = new Date(s.scheduled_at);
    const endT = t.getTime() + (lesson.duration_min || 60) * 60000;
    const vars = {
      lesson_title: lesson.title, url_line: urlLine(lesson.url), url: lesson.url,
      when: fmtInTz(t, config.tz), ping: pingFor(lesson), vc_name: 'الحصة',
      part_line: partLine(s),
    };

    // T-remMin: reminder + warm the audio cache for class time
    if (s.status === 'scheduled' && now >= t.getTime() - remMin * 60000 && now < t) {
      prefetch(s.lesson_id, lesson.url);
      await bus.postTo('channel_dashboard', { content: fill(templates.reminder, { ...vars, when: humanDuration(t - now) }), components: [new ActionRowBuilder().addComponents(subBtn(lesson))] });
      run("UPDATE sessions SET status = 'reminded' WHERE id = ?", s.id);
      continue;
    }

    // T-0: starting — the Coach joins the study VC and plays the lesson.
    // With several courses, cadences can collide: never start a second class
    // while one is live — the tick retries once the other finishes.
    if ((s.status === 'scheduled' || s.status === 'reminded') && now >= t) {
      // bot was offline through the whole class: don't announce a class that's already
      // over — go straight to the missed poll so it gets moved
      if (now >= endT) {
        const slot = proposeSlot(t, s);
        run("UPDATE sessions SET status = 'missed_poll', proposed_at = ?, poll_at = ? WHERE id = ?",
          slot.toISOString(), now.toISOString(), s.id);
        await bus.postTo('channel_dashboard', {
          content: fill(templates.missed, { ...vars, proposed_when: fmtInTz(slot, config.tz) }),
          components: [sessRow(s)],
        });
        markDashboardDirty();
        continue;
      }
      if (A.listSessions({ future: true }).some(x => x.status === 'live' && x.id !== s.id)) continue;
      const msg = await bus.postTo('channel_dashboard', {
        content: fill(templates.starting, vars),
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`sess:finish:${s.id}`).setLabel('🏁 إنهاء الحصة').setStyle(ButtonStyle.Success),
          subBtn(lesson),
        )],
      });
      run("UPDATE sessions SET status = 'live', live_post_id = ? WHERE id = ?", msg?.id ?? '', s.id);
      if (lesson.url) startStream(client, streamOpts(s, lesson));
      continue;
    }

    // live: finish at end-time, or open the missed-poll
    if (s.status === 'live') {
      const att = A.sessionAttendance(s.id).filter(a => (a.minutes ?? 0) > 0 || !a.left_at);
      if (att.length > 0 && now >= endT) {
        await finishSession({ client, bus, sessionId: s.id });
        continue;
      }
      if (now < endT && client) resumeIfSilent(client, s, lesson, now);
      if (att.length === 0 && now >= t.getTime() + missMin * 60000 && !s.proposed_at) {
        stopStream();
        const slot = proposeSlot(t, s);
        run("UPDATE sessions SET status = 'missed_poll', proposed_at = ?, poll_at = ? WHERE id = ?",
          slot.toISOString(), now.toISOString(), s.id);
        await bus.postTo('channel_dashboard', {
          content: fill(templates.missed, { ...vars, proposed_when: fmtInTz(slot, config.tz) }),
          components: [sessRow(s)],
        });
        markDashboardDirty();
      }
      continue;
    }

    // poll expired -> auto-move
    if (s.status === 'missed_poll') {
      const pollAt = s.poll_at ? new Date(s.poll_at).getTime() : t.getTime();
      if (now >= pollAt + 24 * 3600000) {
        const slot = s.proposed_at ? new Date(s.proposed_at) : proposeSlot(t);
        A.setSession(s.id, slot.toISOString());
        run('UPDATE sessions SET poll_at = NULL WHERE id = ?', s.id);
        await bus.postTo('channel_dashboard', {
          content: fill(templates.missed_auto_moved, { lesson_title: lesson.title, when: fmtInTz(slot, config.tz) }),
        });
        markDashboardDirty();
      }
    }
  }
  await refreshDashboard(client);
  await refreshMemberDashboards(client).catch(e => console.log('[memberdash] sweep:', e.message));
  refreshAcademyDashboard(client).catch(e => console.log('[acadash] sweep:', e.message));
}

// On-demand: pull the lesson's session to RIGHT NOW (create one if needed)
// and fire the starting transition immediately.
export async function startSessionNow({ client = null, bus, lessonId, now = new Date() } = {}) {
  const lesson = A.getLesson(lessonId);
  if (!lesson) return { ok: false, error: 'الدرس غير موجود.' };
  if (A.listSessions({ future: true }).some(s => s.status === 'live')) {
    return { ok: false, error: 'توجد حصة مباشرة الآن — أنهِها أولاً.' };
  }
  let s = A.sessionForLesson(lessonId);
  let offsetMin = 0;
  if (s) {
    A.setSession(s.id, now.toISOString());
    s = A.getSession(s.id);
    offsetMin = s.offset_min || 0;
  } else {
    // no scheduled session: continue the video from where past classes stopped
    offsetMin = A.nextOffsetForLesson(lessonId);
    const r = getDb().prepare("INSERT INTO sessions (lesson_id, scheduled_at, status, offset_min) VALUES (?, ?, 'scheduled', ?)")
      .run(lessonId, now.toISOString(), offsetMin);
    s = A.getSession(Number(r.lastInsertRowid));
  }
  const vars = {
    lesson_title: lesson.title, url_line: urlLine(lesson.url), url: lesson.url,
    when: fmtInTz(now, config.tz), ping: pingFor(lesson), vc_name: 'الحصة',
    part_line: partLine(s),
  };
  const msg = await bus.postTo('channel_dashboard', {
    content: fill(templates.starting, vars),
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`sess:finish:${s.id}`).setLabel('🏁 إنهاء الحصة').setStyle(ButtonStyle.Success),
      subBtn(lesson),
    )],
  });
  run("UPDATE sessions SET status = 'live', live_post_id = ? WHERE id = ?", msg?.id ?? '', s.id);
  if (lesson.url) startStream(client, streamOpts(s, lesson));
  markDashboardDirty();
  await refreshDashboard(client, { force: true });
  return { ok: true, session: A.getSession(s.id) };
}

export async function finishSession({ client, bus, sessionId }) {
  stopStream();
  const res = A.finalizeSession(sessionId);
  if (!res) return null;
  const lesson = A.getLesson(res.session.lesson_id);
  await bus.postTo('channel_dashboard', {
    content: fill(templates.session_done, {
      lesson_title: lesson?.title ?? '?',
      part_line: partLine(res.session),
    }),
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`complete:${res.session.lesson_id}`).setLabel('✅ أنهيت هذا الدرس').setStyle(ButtonStyle.Success),
    )],
  });
  // comprehension check: the lesson's questions go out right after class
  for (const q of A.listQuestions({ lessonId: res.session.lesson_id })) {
    await postQuestion(bus, q);
  }
  for (const a of res.attendees) {
    const before = A.xpTotal(a.userId);
    const base = Number(getSetting('xp_attendance', '20'));
    const bonus = Math.min(a.streak * Number(getSetting('xp_streak_bonus', '10')), Number(getSetting('xp_streak_bonus_cap', '50')));
    A.awardXp(a.userId, base + bonus, 'attendance');
    markMemberDirty(a.userId); // streak/attendance changed -> their private dashboard updates
  }
  markDashboardDirty();
  await refreshDashboard(client, { force: true });
  return res;
}
