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
import { announceLevelUp } from './gamification.js';

const run = (sql, ...p) => getDb().prepare(sql).run(...p);
const fill = (text, vars) => text.replace(/\{\{(\w+)\}\}/g, (_, k) => vars?.[k] ?? '');
const urlLine = url => (url ? `▶️ ${url}` : '');
const pingTag = () => { const r = getSetting('ping_role'); return r ? `<@&${r}>` : '@here'; };

function sessRow(session) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`sess:move:${session.id}`).setLabel('Yes, move it').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`sess:slots:${session.id}`).setLabel('Pick another time').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`sess:skip:${session.id}`).setLabel('Skip this lesson').setStyle(ButtonStyle.Danger),
  );
}

async function questExpiry(bus) {
  for (const q of A.listQuests()) {
    if (new Date(q.ends_at).getTime() < Date.now()) {
      A.endQuest(q.id);
      await bus.postTo('channel_dashboard', {
        content: fill(templates.quest_expired, { title: q.title, count: A.questCompletionCount(q.id) }),
      });
      markDashboardDirty();
    }
  }
}

// one auto quest per calendar month covering the next week's lessons
async function autoQuest(bus) {
  const weekKey = new Intl.DateTimeFormat('en-CA', { timeZone: config.tz }).format(new Date()).slice(0, 7);
  if (getSetting('quest_week') === weekKey) return;
  const upcoming = A.listSessions({ future: true }).filter(s => new Date(s.scheduled_at).getTime() < Date.now() + 7 * 86400000);
  if (!upcoming.length) return;
  const lessonIds = [...new Set(upcoming.map(s => s.lesson_id))];
  const titles = lessonIds.map(id => A.getLesson(id)?.title).filter(Boolean);
  const ends = new Date(new Date(upcoming[upcoming.length - 1].scheduled_at).getTime() + 86400000).toISOString();
  A.createQuest({
    title: `Keep pace: ${titles.join(' + ')}`,
    description: "Finish this week's lessons and claim the reward!",
    lessonIds, startsAt: new Date().toISOString(), endsAt: ends, auto: true,
  });
  run('UPDATE settings SET value = ? WHERE key = ?', weekKey, 'quest_week');
  await bus.postTo('channel_dashboard', {
    content: fill(templates.quest_new, {
      title: titles.join(' + '), xp: getSetting('xp_quest', '150'), ends: fmtInTz(new Date(ends), config.tz),
    }),
  });
  markDashboardDirty();
}

// next free template slot after `after` — proposal only, no DB writes
export function proposeSlot(after) {
  const tpl = JSON.parse(getSetting('weekly_template_json') || 'null');
  if (!tpl) return new Date(after.getTime() + 7 * 86400000);
  const slots = nextSlots(tpl, after, 4, config.tz);
  const used = new Set(A.listSessions({ future: true }).map(x => x.scheduled_at));
  return slots.find(s => !used.has(s.toISOString())) ?? slots[0] ?? new Date(after.getTime() + 7 * 86400000);
}

export async function tick({ client = null, bus, now = new Date() } = {}) {
  await questExpiry(bus);
  await autoQuest(bus);

  const remMin = Number(getSetting('reminder_minutes_before', '30'));
  const missMin = Number(getSetting('missed_after_minutes', '15'));

  for (const s of A.listSessions({ future: true })) {
    const lesson = A.getLesson(s.lesson_id);
    if (!lesson) continue;
    const t = new Date(s.scheduled_at);
    const endT = t.getTime() + (lesson.duration_min || 60) * 60000;
    const vars = {
      lesson_title: lesson.title, url_line: urlLine(lesson.url), url: lesson.url,
      when: fmtInTz(t, config.tz), ping: pingTag(), vc_name: 'study-room',
    };

    // T-remMin: reminder
    if (s.status === 'scheduled' && now >= t.getTime() - remMin * 60000 && now < t) {
      await bus.postTo('channel_dashboard', { content: fill(templates.reminder, { ...vars, when: humanDuration(t - now) }) });
      run("UPDATE sessions SET status = 'reminded' WHERE id = ?", s.id);
      continue;
    }

    // T-0: starting
    if ((s.status === 'scheduled' || s.status === 'reminded') && now >= t) {
      const msg = await bus.postTo('channel_dashboard', {
        content: fill(templates.starting, vars),
        components: [new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`sess:finish:${s.id}`).setLabel('Finish session').setStyle(ButtonStyle.Success),
        )],
      });
      run("UPDATE sessions SET status = 'live', live_post_id = ? WHERE id = ?", msg?.id ?? '', s.id);
      continue;
    }

    // live: finish at end-time, or open the missed-poll
    if (s.status === 'live') {
      const att = A.sessionAttendance(s.id).filter(a => (a.minutes ?? 0) > 0 || !a.left_at);
      if (att.length > 0 && now >= endT) {
        await finishSession({ client, bus, sessionId: s.id });
        continue;
      }
      if (att.length === 0 && now >= t.getTime() + missMin * 60000 && !s.proposed_at) {
        const slot = proposeSlot(t);
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
}

export async function finishSession({ client, bus, sessionId }) {
  const res = A.finalizeSession(sessionId);
  if (!res) return null;
  const lesson = A.getLesson(res.session.lesson_id);
  await bus.postTo('channel_dashboard', {
    content: fill(templates.session_done, { lesson_title: lesson?.title ?? '?', xp: res.attendees.length ? 'attendance + streak bonus' : '0' }),
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`complete:${res.session.lesson_id}`).setLabel('✅ I finished this lesson').setStyle(ButtonStyle.Success),
    )],
  });
  for (const a of res.attendees) {
    const before = A.xpTotal(a.userId);
    const base = Number(getSetting('xp_attendance', '20'));
    const bonus = Math.min(a.streak * Number(getSetting('xp_streak_bonus', '10')), Number(getSetting('xp_streak_bonus_cap', '50')));
    A.awardXp(a.userId, base + bonus, 'attendance');
    await announceLevelUp(client, a.userId, before);
  }
  markDashboardDirty();
  await refreshDashboard(client, { force: true });
  return res;
}
