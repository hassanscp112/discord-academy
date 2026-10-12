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

// A schedule template is one of:
//   { mode: 'days',     days: [0..6], time }      specific weekdays
//   { mode: 'daily',    time }                    every day
//   { mode: 'interval', everyN: 1..30, time }     every N days
// The legacy shape { days, time } (no mode) reads as 'days'.
export function normalizeTemplate(t) {
  if (!t || typeof t !== 'object' || !/^\d{1,2}:\d{2}$/.test(String(t.time ?? ''))) return null;
  const [hh, mm] = String(t.time).split(':').map(Number);
  if (hh > 23 || mm > 59) return null;
  const time = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
  if (t.mode === 'daily') return { mode: 'daily', time };
  if (t.mode === 'interval') {
    const n = Math.round(Number(t.everyN));
    if (!Number.isFinite(n) || n < 1 || n > 30) return null;
    return { mode: 'interval', everyN: n, time };
  }
  const days = [...new Set((t.days ?? []).map(Number))]
    .filter(d => Number.isInteger(d) && d >= 0 && d <= 6).sort((a, b) => a - b);
  if (!days.length) return null;
  return { mode: 'days', days, time };
}

const isoDay = ms => new Date(ms).toISOString().slice(0, 10);

// Given a schedule template (any mode — see normalizeTemplate), produce the
// next `count` distinct slot instants strictly after `from`, in tz order.
export function nextSlots(template, from, count, tz) {
  const tpl = normalizeTemplate(template);
  if (!tpl || count <= 0) return [];

  if (tpl.mode === 'interval') {
    // anchor: first local occurrence of tpl.time after `from`, then every N
    // calendar days (date math in UTC — DST-proof, slots rebuilt per date)
    let anchorDs = null;
    for (let i = 0; i < 40 && !anchorDs; i++) {
      const ds = dateStrInTz(new Date(from.getTime() + i * DAY_MS), tz);
      const slot = zonedToUtc(ds, tpl.time, tz);
      if (slot.getTime() > from.getTime()) anchorDs = ds;
    }
    if (!anchorDs) return [];
    const [y, m, d] = anchorDs.split('-').map(Number);
    const day0 = Date.UTC(y, m - 1, d);
    const slots = [];
    for (let k = 0; k < count; k++) slots.push(zonedToUtc(isoDay(day0 + k * tpl.everyN * DAY_MS), tpl.time, tz));
    return slots;
  }

  const days = tpl.mode === 'daily' ? [0, 1, 2, 3, 4, 5, 6] : tpl.days;
  const slots = [];
  const seen = new Set();
  // walk forward day by day (400 days of headroom for sparse intervals)
  for (let i = 0; i < 400 && slots.length < count; i++) {
    const dayStart = new Date(from.getTime() + i * DAY_MS);
    const ds = dateStrInTz(dayStart, tz);
    const wd = weekdayInTz(dayStart, tz);
    if (!days.includes(wd) || seen.has(ds)) continue;
    seen.add(ds);
    const slot = zonedToUtc(ds, tpl.time, tz);
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
