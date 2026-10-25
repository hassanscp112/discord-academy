// Daily check-in nudges + weekly recap, guarded so they fire once per day.
import { ChannelType } from 'discord.js';
import * as A from '../core/academy.js';
import { getSetting, setSetting } from '../core/db.js';
import { templates } from '../core/templates.js';
import { fmtInTz } from '../core/time.js';
import { config } from '../core/config.js';
import { markDashboardDirty } from './dashboard.js';
import { healthTick } from './health.js';

const fill = (text, vars) => text.replace(/\{\{(\w+)\}\}/g, (_, k) => vars?.[k] ?? '');

function hourInTz(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: config.tz, hour: '2-digit', hour12: false }).format(now));
}
function dateInTz(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.tz }).format(now);
}
function weekdayInTz(now = new Date()) {
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(
    new Intl.DateTimeFormat('en-US', { timeZone: config.tz, weekday: 'short' }).format(now));
}

async function runNudges({ client, bus, now = new Date() } = {}) {
  if (hourInTz(now) !== Number(getSetting('nudge_hour', '18'))) return;
  if (getSetting('nudge_last_run') === dateInTz(now)) return;
  setSetting('nudge_last_run', dateInTz(now));

  const members = A.membersToNudge(Number(getSetting('nudge_cooldown_hours', '48')));
  if (!members.length) return;

  const overDm = getSetting('nudge_over_dm', '1') !== '0';
  const lessonTitle = members[0]?.lesson?.title ?? 'the current lesson';
  if (overDm) {
    for (const m of members) {
      const variants = templates.nudge_dm;
      const text = variants[Math.abs([...m.user_id].reduce((a, c) => a + c.charCodeAt(0), 0)) % variants.length];
      await bus.dm(m.user_id, { content: fill(text, {
        member: m.display_name || 'there', lesson_title: m.lesson.title,
        streak: m.streak > 0 ? `🔥${m.streak}` : 'fresh',
      }) });
      A.logNudge(m.user_id, 'dm');
    }
  } else {
    const ping = getSetting('ping_role') ? `<@&${getSetting('ping_role')}>` : '@here';
    await bus.postTo('channel_dashboard', { content: fill(templates.nudge_channel, {
      ping, lesson_title: lessonTitle,
    }) });
    for (const m of members) A.logNudge(m.user_id, 'channel');
  }
  console.log(`[coach] nudged ${members.length} member(s) about "${lessonTitle}"`);
}

async function runRecap({ client, bus, now = new Date() } = {}) {
  if (weekdayInTz(now) !== Number(getSetting('recap_day', '0'))) return;
  if (hourInTz(now) !== Number(getSetting('recap_hour', '21'))) return;
  if (getSetting('recap_last_run') === dateInTz(now)) return;
  setSetting('recap_last_run', dateInTz(now));

  const r = A.weeklyRecap({});
  const closers = templates.recap_closing;
  const closing = closers[Math.abs(dateInTz(now).split('-').join('') % closers.length) % closers.length];
  const topName = r.top ? (A.getParticipant(r.top.user_id)?.display_name || r.top.user_id) : '_لا أحد بعد_';

  await bus.postTo('channel_dashboard', { content: fill(templates.recap, {
    sessions: r.sessions, active: r.active, top: topName,
    completions: r.completions, quests: r.questsDone, closing,
  }) });

  // falling-behind report: bosses only
  if (r.falling.length) {
    const lines = r.falling.map(f => `💤 **${f.display_name || f.user_id}** — لا نشاط هذا الأسبوع`);
    await bus.bossDm({ content: `📉 **متأخرون هذا الأسبوع** (${r.falling.length}):\n${lines.join('\n')}` });
  }
  markDashboardDirty();
}

export function startEngines({ client = null, bus, intervalMs = 60000 } = {}) {
  const loop = async () => {
    try {
      const now = new Date();
      await runNudges({ client, bus, now });
      await runRecap({ client, bus, now });
      await healthTick({ bus, now });
    } catch (e) { console.error('[coach] engine error:', e); }
  };
  loop();
  return setInterval(loop, intervalMs);
}
