// Production visibility: errors reach the owner instead of dying in a console
// log. Immediate DM on first occurrence of an error type (throttled to one per
// hour per signature), plus a daily heartbeat with yesterday's summary.
import * as A from '../core/academy.js';
import { getSetting, setSetting } from '../core/db.js';
import { config } from '../core/config.js';

const errors = []; // recent { key, source, message, count, lastAt }
const THROTTLE_MS = 60 * 60 * 1000;
let dm = null; // injected sender

export function initHealth({ sendDm }) {
  dm = sendDm;
}

export function reportError(source, err) {
  const message = String(err?.message ?? err ?? 'unknown error').slice(0, 300);
  const key = `${source}:${message.slice(0, 80)}`;
  let entry = errors.find(e => e.key === key);
  if (!entry) {
    entry = { key, source, message, count: 0, lastDmAt: 0 };
    errors.push(entry);
    if (errors.length > 100) errors.shift();
  }
  entry.count += 1;
  entry.lastAt = Date.now();
  console.error(`[health] ${source}:`, message);
  // DM immediately for a new signature, then at most hourly
  if (dm && Date.now() - entry.lastDmAt > THROTTLE_MS) {
    entry.lastDmAt = Date.now();
    dm(`⚠️ **${source}**\n\`${message}\``).catch(() => {});
  }
}

function hourInTz(now = new Date()) {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: config.tz, hour: '2-digit', hour12: false }).format(now));
}
function dateInTz(now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: config.tz }).format(now);
}

// called from the check-ins engine loop (once a minute)
export async function healthTick({ bus, now = new Date() } = {}) {
  if (hourInTz(now) !== Number(getSetting('health_hour', '9'))) return;
  if (getSetting('health_last_run') === dateInTz(now)) return;
  setSetting('health_last_run', dateInTz(now));

  const o = A.overview();
  const err24 = errors.filter(e => Date.now() - e.lastAt < 24 * 3600000);
  const errLines = err24.slice(0, 8).map(e => `• **${e.source}** ×${e.count}: \`${e.message.slice(0, 120)}\``);
  await bus.bossDm({
    content: [
      `🫀 **نبض الأكاديمية** — ${dateInTz(now)}`,
      `✅ الخدمة تعمل · ${o.participants} عضو · ${o.courses.length} دورة · ${o.lessons_total} درس`,
      o.next_session ? `⏰ الحصة القادمة: **${A.getLesson(o.next_session.lesson_id)?.title ?? '?'}**` : '⏰ لا حصص مجدولة',
      err24.length
        ? `\n⚠️ **أخطاء آخر ٢٤ ساعة (${err24.length}):**\n${errLines.join('\n')}`
        : '\n✨ لا أخطاء في آخر ٢٤ ساعة',
    ].join('\n'),
  });
}
