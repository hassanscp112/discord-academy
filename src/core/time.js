// Timezone-aware helpers. All DB timestamps are UTC ISO strings; schedule
// templates are expressed in the configured local timezone.

export function tzOffsetMs(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = {};
  for (const p of dtf.formatToParts(date)) if (p.type !== 'literal') parts[p.type] = p.value;
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
  return asUTC - date.getTime();
}

// 'YYYY-MM-DD' + 'HH:mm' in tz -> Date (UTC instant)
export function zonedToUtc(dateStr, timeStr, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const [hh, mm] = timeStr.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const off1 = tzOffsetMs(new Date(guess), tz);
  const off2 = tzOffsetMs(new Date(guess - off1), tz);
  return new Date(guess - off2);
}

export function fmtInTz(date, tz, opts = {}) {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: tz,
    weekday: 'short', day: 'numeric', month: 'short',
    hour: '2-digit', minute: '2-digit', hour12: false,
    ...opts,
  }).format(date);
}

const DAY_MS = 86400000;
const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function weekdayInTz(date, tz) {
  const s = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(date);
  return WD.indexOf(s);
}

function dateStrInTz(date, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

// Given a weekly template { days: [0..6], time: 'HH:mm' }, produce the next
// `count` distinct slot instants strictly after `from`, in tz order.
export function nextSlots(template, from, count, tz) {
  if (!template || !template.days?.length) return [];
  const slots = [];
  const seen = new Set();
  // walk forward day by day (56 days of headroom for sparse templates)
  for (let i = 0; i < 56 && slots.length < count; i++) {
    const dayStart = new Date(from.getTime() + i * DAY_MS);
    const ds = dateStrInTz(dayStart, tz);
    const wd = weekdayInTz(dayStart, tz);
    if (!template.days.includes(wd) || seen.has(ds)) continue;
    seen.add(ds);
    const slot = zonedToUtc(ds, template.time, tz);
    if (slot.getTime() > from.getTime()) slots.push(slot);
  }
  return slots;
}

export function humanDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min}m`;
  const h = Math.floor(min / 60), m = min % 60;
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}
