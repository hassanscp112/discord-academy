// Domain logic for the academy. Pure functions on the SQLite DB — no Discord
// here. Both the Coach and the AI Admin studio build on this.
import { getDb, getSetting, setSetting, getTemplate, getLevels } from './db.js';
import { nextSlots, normalizeTemplate } from './time.js';

const nowIso = () => new Date().toISOString();

// stable id for a YouTube link (dedup key for playlist imports)
export function videoIdFromUrl(url) {
  if (!url) return null;
  const m = String(url).match(/(?:[?&]v=|youtu\.be\/|shorts\/|embed\/)([\w-]{6,})/);
  return m ? m[1] : null;
}

// ---------- courses ----------
// Each course owns its lessons and its own schedule cadence
// (mode: 'days' | 'daily' | 'interval' — same shapes as normalizeTemplate).
function courseWithTemplate(c) {
  const days = String(c.days ?? '').split(',').map(Number)
    .filter(d => Number.isInteger(d) && d >= 0 && d <= 6);
  return { ...c, template: normalizeTemplate({ mode: c.mode, days, everyN: c.every_n, time: c.time }) };
}

export function listCourses() {
  return getDb().prepare('SELECT * FROM courses ORDER BY position, id').all().map(courseWithTemplate);
}

export function getCourse(id) {
  const c = getDb().prepare('SELECT * FROM courses WHERE id = ?').get(id);
  return c ? courseWithTemplate(c) : null;
}

export function courseOfLesson(lessonId) {
  const l = getLesson(lessonId);
  return l ? getCourse(l.course_id) : null;
}

export function createCourse({ title, mode = 'days', days = [], everyN = 2, time = '21:00' }) {
  const tpl = normalizeTemplate({ mode, days, everyN, time });
  if (!tpl) throw new Error('إيقاع غير صالح للدورة.');
  const max = getDb().prepare('SELECT COALESCE(MAX(position), 0) AS p FROM courses').get().p;
  const r = getDb().prepare('INSERT INTO courses (title, position, mode, days, every_n, time) VALUES (?, ?, ?, ?, ?, ?)')
    .run(String(title).trim(), max + 1, tpl.mode, tpl.days ? tpl.days.join(',') : '', tpl.everyN ?? 2, tpl.time);
  return Number(r.lastInsertRowid);
}

// any of { title, mode, days, everyN, time } — omitted fields keep their value
export function updateCourse(id, patch = {}) {
  const c = getDb().prepare('SELECT * FROM courses WHERE id = ?').get(id);
  if (!c) return false;
  const tpl = normalizeTemplate({
    mode: patch.mode ?? c.mode,
    days: patch.days ?? String(c.days).split(',').filter(s => s !== '').map(Number),
    everyN: patch.everyN ?? c.every_n,
    time: patch.time ?? c.time,
  });
  if (!tpl) throw new Error('إيقاع غير صالح للدورة.');
  getDb().prepare('UPDATE courses SET title = ?, mode = ?, days = ?, every_n = ?, time = ? WHERE id = ?')
    .run(patch.title?.trim() || c.title, tpl.mode, tpl.days ? tpl.days.join(',') : '', tpl.everyN ?? 2, tpl.time, id);
  return true;
}

export function removeCourse(id) {
  const db = getDb();
  if (!db.prepare('SELECT 1 FROM courses WHERE id = ?').get(id)) return false;
  if (db.prepare('SELECT COUNT(*) AS c FROM courses').get().c <= 1) throw new Error('لا يمكن حذف الدورة الوحيدة.');
  for (const l of listLessons(id)) removeLesson(l.id); // cascades sessions
  db.prepare('DELETE FROM courses WHERE id = ?').run(id);
  return true;
}

// ---------- lessons ----------
export function addLesson({ title, url = '', durationMin = 60, position = null, videoId = null, videoDurationSec = null, courseId = null }) {
  const db = getDb();
  const cid = courseId ?? db.prepare('SELECT MIN(id) AS id FROM courses').get().id;
  const max = db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM lessons WHERE course_id = ?').get(cid).p;
  const pos = position ?? max + 1;
  db.prepare('UPDATE lessons SET position = position + 1 WHERE course_id = ? AND position >= ?').run(cid, pos);
  const r = db.prepare('INSERT INTO lessons (position, title, url, duration_min, video_id, video_duration_sec, course_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(pos, title, url, durationMin, videoId ?? videoIdFromUrl(url), videoDurationSec, cid);
  return r.lastInsertRowid;
}

export function listLessons(courseId = null) {
  if (courseId == null) return getDb().prepare('SELECT * FROM lessons ORDER BY course_id, position').all();
  return getDb().prepare('SELECT * FROM lessons WHERE course_id = ? ORDER BY position').all(courseId);
}

export function getLesson(id) {
  return getDb().prepare('SELECT * FROM lessons WHERE id = ?').get(id);
}

export function removeLesson(id) {
  const db = getDb();
  const lesson = getLesson(id);
  if (!lesson) return false;
  db.prepare('DELETE FROM lessons WHERE id = ?').run(id);
  db.prepare('DELETE FROM sessions WHERE lesson_id = ?').run(id);
  reorder(listLessons().map(l => l.id));
  return true;
}

export function reorder(ids) {
  const db = getDb();
  const stmt = db.prepare('UPDATE lessons SET position = ? WHERE id = ?');
  ids.forEach((id, i) => stmt.run(i + 1, id));
}

// Bulk-add playlist entries into one course. Dedupes by video id (or URL)
// across the whole academy. Each entry: { title, url, videoId?, durationSec? }
// — durationMin is the class length.
export function importPlaylist(entries, { durationMin = 60, courseId = null } = {}) {
  const db = getDb();
  const cid = courseId ?? db.prepare('SELECT MIN(id) AS id FROM courses').get().id;
  const existing = new Set(
    db.prepare('SELECT video_id, url FROM lessons').all()
      .map(r => r.video_id ?? videoIdFromUrl(r.url) ?? r.url).filter(Boolean)
  );
  let pos = db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM lessons WHERE course_id = ?').get(cid).p;
  const ins = db.prepare(
    'INSERT INTO lessons (position, title, url, duration_min, video_id, video_duration_sec, course_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const added = [];
  for (const e of entries) {
    const key = e.videoId ?? videoIdFromUrl(e.url) ?? e.url;
    if (key && existing.has(key)) continue;
    pos += 1;
    const r = ins.run(pos, e.title, e.url, durationMin, e.videoId ?? videoIdFromUrl(e.url) ?? null, e.durationSec ?? null, cid);
    if (key) existing.add(key);
    added.push({ id: Number(r.lastInsertRowid), title: e.title, durationSec: e.durationSec ?? null });
  }
  return { added, skipped: entries.length - added.length };
}

// ---------- schedule ----------
// Legacy single-course entry point: writes the global setting AND syncs the
// first course (Discord /schedule + AI publish still land here).
export function setTemplate(tpl) {
  const norm = normalizeTemplate(tpl);
  if (!norm) throw new Error('Invalid schedule template.');
  setSetting('weekly_template_json', JSON.stringify(norm));
  const first = getDb().prepare('SELECT MIN(id) AS id FROM courses').get().id;
  if (first != null) updateCourse(first, norm);
  return norm;
}

export function clearTemplate() {
  setSetting('weekly_template_json', '');
}

// A lesson longer than one class is split: how many sessions does it need?
// duration_min on the lesson is the *class* length; video_duration_sec is the
// real content length (known when imported from YouTube).
export function lessonParts(lesson) {
  const videoSec = lesson?.video_duration_sec ?? null;
  const sessionSec = Math.max(5, lesson?.duration_min ?? 60) * 60;
  const parts = videoSec && videoSec > sessionSec ? Math.ceil(videoSec / sessionSec) : 1;
  return { parts, videoSec };
}

// which slice of the video a session covers ("part 2 of 3, minutes 60–120")
export function sessionPartInfo(session) {
  const lesson = getLesson(session.lesson_id);
  const fromMin = session.offset_min || 0;
  if (!lesson) return { part: 1, parts: 1, fromMin, toMin: null };
  const { parts } = lessonParts(lesson);
  const step = Math.max(1, lesson.duration_min || 60);
  const part = Math.min(parts, Math.floor(fromMin / step) + 1);
  return { part, parts, fromMin, toMin: part < parts ? fromMin + step : null };
}

// where a "start now" ad-hoc session should resume: one part per held session
export function nextOffsetForLesson(lessonId) {
  const lesson = getLesson(lessonId);
  if (!lesson) return 0;
  const done = getDb().prepare("SELECT COUNT(*) AS c FROM sessions WHERE lesson_id = ? AND status = 'done'").get(lessonId).c;
  const { parts } = lessonParts(lesson);
  return Math.min(done, Math.max(0, parts - 1)) * (lesson.duration_min || 60);
}

// Generate sessions for ONE course's planned lessons into that course's
// cadence slots. A lesson needing several parts occupies several consecutive
// slots, each continuing the video where the previous one stopped.
export function generateScheduleForCourse(courseId, { count = null, from = new Date() } = {}) {
  const course = getCourse(courseId);
  if (!course) throw new Error('Course not found.');
  if (!course.template) throw new Error('هذه الدورة بلا إيقاع — اختر الأيام/التكرار والوقت أولاً.');
  const planned = listLessons(courseId)
    .filter(l => l.status !== 'done' && l.status !== 'skipped')
    .filter(l => !sessionForLesson(l.id));
  if (!planned.length) return [];
  const partInfo = new Map(planned.map(l => [l.id, lessonParts(l)]));
  const totalParts = planned.reduce((n, l) => n + partInfo.get(l.id).parts, 0);
  const wanted = Math.min(count ?? totalParts, totalParts);
  const slots = nextSlots(course.template, from, wanted, getSetting('tz', 'UTC'));
  if (slots.length < wanted) throw new Error(`إيقاع الدورة أعطى ${slots.length} موعداً فقط لـ ${wanted} حصة (الفيديو الطويل يأخذ عدة مواعيد).`);
  const ins = getDb().prepare('INSERT INTO sessions (lesson_id, scheduled_at, offset_min) VALUES (?, ?, ?)');
  const created = [];
  let i = 0;
  for (const lesson of planned) {
    for (let p = 0; p < partInfo.get(lesson.id).parts && i < wanted; p++, i++) {
      const offset = p * lesson.duration_min;
      const r = ins.run(lesson.id, slots[i].toISOString(), offset);
      created.push({ id: Number(r.lastInsertRowid), lesson_id: lesson.id, scheduled_at: slots[i].toISOString(), offset_min: offset, status: 'scheduled' });
    }
    if (i >= wanted) break;
  }
  return created;
}

// All courses at once — courses without a cadence are skipped.
export function generateSchedule(opts = {}) {
  const out = [];
  for (const c of listCourses()) {
    try { out.push(...generateScheduleForCourse(c.id, opts)); }
    catch (e) { if (!/بلا إيقاع/.test(e.message)) throw e; }
  }
  return out;
}

export function setSession(sessionId, isoDate) {
  getDb().prepare("UPDATE sessions SET scheduled_at = ?, status = 'scheduled', proposed_at = NULL WHERE id = ?")
    .run(new Date(isoDate).toISOString(), sessionId);
}

// Move a session to the next free cadence slot of ITS OWN course after `after`.
export function pushToNextSlot(sessionId, after = new Date()) {
  const session = getSession(sessionId);
  const course = session ? courseOfLesson(session.lesson_id) : null;
  if (!course?.template) throw new Error('The course has no cadence set.');
  const slots = nextSlots(course.template, after, 4, getSetting('tz', 'UTC'));
  const used = new Set(listSessions({ future: true }).map(s => s.scheduled_at));
  const slot = slots.find(s => !used.has(s.toISOString())) ?? slots[0];
  if (!slot) throw new Error('No free slot found in the next weeks.');
  setSession(sessionId, slot.toISOString());
  return slot;
}

export function cancelSession(sessionId) {
  getDb().prepare("UPDATE sessions SET status = 'cancelled' WHERE id = ?").run(sessionId);
}

export function getSession(id) {
  return getDb().prepare('SELECT * FROM sessions WHERE id = ?').get(id);
}

export function sessionForLesson(lessonId) {
  return getDb().prepare(
    "SELECT * FROM sessions WHERE lesson_id = ? AND status IN ('scheduled','reminded','live') ORDER BY scheduled_at LIMIT 1"
  ).get(lessonId);
}

export function listSessions({ future = false, limit = 100 } = {}) {
  const sql = future
    ? "SELECT * FROM sessions WHERE status IN ('scheduled','reminded','live','missed_poll') ORDER BY scheduled_at LIMIT ?"
    : 'SELECT * FROM sessions ORDER BY scheduled_at DESC LIMIT ?';
  return getDb().prepare(sql).all(limit);
}

export function nextSession() {
  return getDb().prepare(
    "SELECT s.*, l.title AS lesson_title, l.url AS lesson_url FROM sessions s JOIN lessons l ON l.id = s.lesson_id " +
    "WHERE s.status IN ('scheduled','reminded','live') ORDER BY s.scheduled_at LIMIT 1"
  ).get();
}

// The lesson everyone should currently be studying: the one attached to the
// next session, else the first planned lesson without a session.
export function currentLesson() {
  const ns = nextSession();
  if (ns) return getLesson(ns.lesson_id);
  return listLessons().find(l => l.status !== 'done' && l.status !== 'skipped') ?? null;
}

// ---------- participants ----------
export function upsertParticipant(userId, displayName) {
  getDb().prepare(
    'INSERT INTO participants (user_id, display_name, joined_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(user_id) DO UPDATE SET display_name = excluded.display_name'
  ).run(userId, displayName ?? '', nowIso());
}

export function getParticipant(userId) {
  return getDb().prepare('SELECT * FROM participants WHERE user_id = ?').get(userId);
}

export function listParticipants() {
  return getDb().prepare('SELECT * FROM participants ORDER BY display_name').all();
}

export function optOut(userId, disabled) {
  getDb().prepare('UPDATE participants SET dms_enabled = ? WHERE user_id = ?').run(disabled ? 0 : 1, userId);
  return !disabled;
}

// ---------- progress / XP / levels ----------
export function completeLesson(userId, lessonId) {
  const db = getDb();
  const existing = db.prepare('SELECT 1 FROM progress WHERE user_id = ? AND lesson_id = ?').get(userId, lessonId);
  if (existing) return { already: true };
  db.prepare('INSERT INTO progress (user_id, lesson_id, completed_at) VALUES (?, ?, ?)').run(userId, lessonId, nowIso());
  const { total, granted } = awardXp(userId, Number(getSetting('xp_completion', '50')), 'lesson');
  return { already: false, total, granted, level: levelFor(total) };
}

export function listProgress(userId) {
  return getDb().prepare(
    'SELECT p.*, l.title FROM progress p JOIN lessons l ON l.id = p.lesson_id WHERE p.user_id = ? ORDER BY p.completed_at'
  ).all(userId);
}

// one member's checklist inside one course: which lessons are done + what's next
export function courseProgress(courseId, userId) {
  const lessons = listLessons(courseId);
  const doneRows = getDb().prepare('SELECT lesson_id, completed_at FROM progress WHERE user_id = ?').all(userId);
  const at = new Map(doneRows.map(r => [r.lesson_id, r.completed_at]));
  const items = lessons.map(l => ({
    lesson_id: l.id, position: l.position, title: l.title,
    done: at.has(l.id), completed_at: at.get(l.id) ?? null,
  }));
  return {
    total: items.length,
    done: items.filter(i => i.done).length,
    items,
    next: items.find(i => !i.done) ?? null,
  };
}

// every member's standing in one course, best-progress first (course roster)
export function courseRoster(courseId) {
  const lessons = listLessons(courseId);
  const rows = getDb().prepare(
    'SELECT p.user_id, p.lesson_id, p.completed_at FROM progress p JOIN lessons l ON l.id = p.lesson_id WHERE l.course_id = ?'
  ).all(courseId);
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, new Map());
    byUser.get(r.user_id).set(r.lesson_id, r.completed_at);
  }
  return listParticipants().map(part => {
    const doneMap = byUser.get(part.user_id) ?? new Map();
    const next = lessons.find(l => !doneMap.has(l.id)) ?? null;
    return {
      user_id: part.user_id,
      name: part.display_name || part.user_id,
      done: doneMap.size,
      total: lessons.length,
      next_lesson: next ? { id: next.id, title: next.title } : null,
      last_completed_at: doneMap.size ? [...doneMap.values()].sort().pop() : null,
    };
  }).sort((a, b) => b.done - a.done || a.name.localeCompare(b.name));
}

export function awardXp(userId, amount, reason) {
  const db = getDb();
  db.prepare('INSERT INTO xp_events (user_id, amount, reason, created_at) VALUES (?, ?, ?, ?)')
    .run(userId, amount, reason, nowIso());
  const total = db.prepare('SELECT COALESCE(SUM(amount),0) AS t FROM xp_events WHERE user_id = ?').get(userId).t;
  return { total, granted: amount };
}

export function xpTotal(userId) {
  return getDb().prepare('SELECT COALESCE(SUM(amount),0) AS t FROM xp_events WHERE user_id = ?').get(userId).t;
}

export function levelFor(xp) {
  const levels = getLevels();
  let lvl = levels[0];
  for (const l of levels) if (xp >= l.xp) lvl = l;
  return lvl;
}

export function xpLeaderboard(limit = 10) {
  return getDb().prepare(
    'SELECT user_id, SUM(amount) AS xp FROM xp_events GROUP BY user_id ORDER BY xp DESC LIMIT ?'
  ).all(limit);
}

// Streak = number of consecutive *held* sessions attended, most recent first.
// Sessions that nobody attended (missed) don't break streaks.
export function currentStreak(userId) {
  const held = getDb().prepare(
    "SELECT s.id FROM sessions s WHERE s.status = 'done' ORDER BY s.scheduled_at DESC"
  ).all();
  const mine = new Set(
    getDb().prepare('SELECT session_id FROM attendance WHERE user_id = ? AND minutes > 0').all(userId).map(r => r.session_id)
  );
  let streak = 0;
  for (const s of held) {
    if (mine.has(s.id)) streak++;
    else if (sessionAttendance(s.id).length > 0) break; // session had others; user skipped
    // else: nobody attended; streak unaffected
  }
  return streak;
}

// ---------- attendance ----------
export function recordJoin(sessionId, userId) {
  getDb().prepare(
    'INSERT INTO attendance (session_id, user_id, joined_at) VALUES (?, ?, ?) ' +
    'ON CONFLICT(session_id, user_id) DO NOTHING'
  ).run(sessionId, userId, nowIso());
}

export function recordLeave(sessionId, userId) {
  const row = getDb().prepare('SELECT * FROM attendance WHERE session_id = ? AND user_id = ?').get(sessionId, userId);
  if (!row || row.left_at) return;
  const minutes = Math.max(1, Math.round((Date.now() - new Date(row.joined_at).getTime()) / 60000));
  getDb().prepare('UPDATE attendance SET left_at = ?, minutes = ? WHERE session_id = ? AND user_id = ?')
    .run(nowIso(), minutes, sessionId, userId);
}

export function sessionAttendance(sessionId) {
  return getDb().prepare('SELECT * FROM attendance WHERE session_id = ?').all(sessionId);
}

export function finalizeSession(sessionId) {
  const session = getSession(sessionId);
  if (!session || session.status === 'done') return null;
  const att = sessionAttendance(sessionId);
  for (const a of att) {
    if (!a.left_at) recordLeave(sessionId, a.user_id);
  }
  getDb().prepare("UPDATE sessions SET status = 'done' WHERE id = ?").run(sessionId);
  getDb().prepare("UPDATE lessons SET status = 'done' WHERE id = ? AND (SELECT COUNT(*) FROM sessions WHERE lesson_id = lessons.id AND status IN ('scheduled','reminded','live')) = 0")
    .run(session.lesson_id);
  // attendees with actual time in the room; XP awarding happens in the coach layer
  const attendees = sessionAttendance(sessionId)
    .filter(a => (a.minutes ?? 0) > 0)
    .map(a => ({ userId: a.user_id, minutes: a.minutes, streak: currentStreak(a.user_id) }));
  return { session, attendees };
}

// ---------- quests: checklist of accomplishments (book / lecture / course) ----------
export const QUEST_CATEGORIES = ['book', 'lecture', 'course'];

export function createQuest({ title, description = '', category = 'lecture' }) {
  const now = new Date().toISOString();
  const r = getDb().prepare(
    "INSERT INTO quests (title, description, lesson_ids, starts_at, ends_at, xp_reward, auto, category) VALUES (?, ?, '[]', ?, ?, 0, 0, ?)"
  ).run(title, description, now, new Date(Date.now() + 10 * 365 * 86400000).toISOString(),
    QUEST_CATEGORIES.includes(category) ? category : 'lecture');
  return Number(r.lastInsertRowid);
}

export function listQuests({ activeOnly = true } = {}) {
  const sql = activeOnly
    ? "SELECT * FROM quests WHERE status = 'active' ORDER BY id DESC"
    : 'SELECT * FROM quests ORDER BY id DESC';
  return getDb().prepare(sql).all();
}

export function endQuest(questId) {
  getDb().prepare("UPDATE quests SET status = 'ended' WHERE id = ?").run(questId);
}

export function questCompletedBy(questId, userId) {
  return !!getDb().prepare('SELECT 1 FROM quest_completions WHERE quest_id = ? AND user_id = ?').get(questId, userId);
}

// member ticks a checklist item — no XP, just the record
export function checkQuest(questId, userId) {
  const quest = getDb().prepare("SELECT * FROM quests WHERE id = ? AND status = 'active'").get(questId);
  if (!quest) return null;
  const r = getDb().prepare(
    'INSERT OR IGNORE INTO quest_completions (quest_id, user_id, completed_at) VALUES (?, ?, ?)'
  ).run(questId, userId, nowIso());
  return { quest, first: r.changes > 0 };
}

export function questCompletionCount(questId) {
  return getDb().prepare('SELECT COUNT(*) AS c FROM quest_completions WHERE quest_id = ?').get(questId).c;
}

// ---------- engagement / recap ----------
export function weeklyRecap({ sinceDays = 7 } = {}) {
  const since = new Date(Date.now() - sinceDays * 86400000).toISOString();
  const db = getDb();
  const sessions = db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE status = 'done' AND scheduled_at >= ?").get(since).c;
  const completions = db.prepare('SELECT COUNT(*) AS c FROM progress WHERE completed_at >= ?').get(since).c;
  const questsDone = db.prepare('SELECT COUNT(*) AS c FROM quest_completions WHERE completed_at >= ?').get(since).c;
  const xpWeek = db.prepare('SELECT user_id, SUM(amount) AS xp FROM xp_events WHERE created_at >= ? GROUP BY user_id ORDER BY xp DESC').all(since);
  const active = xpWeek.length;
  const top = xpWeek[0] ?? null;
  // falling behind: participants with no xp at all this week
  const falling = listParticipants()
    .filter(p => !xpWeek.some(x => x.user_id === p.user_id))
    .map(p => ({ ...p, totalXp: xpTotal(p.user_id) }));
  return { sessions, completions, questsDone, active, top, falling, xpWeek };
}

// ---------- nudges ----------
export function membersToNudge(cooldownHours = 48) {
  const lesson = currentLesson();
  if (!lesson) return [];
  const cutoff = new Date(Date.now() - cooldownHours * 3600000).toISOString();
  const done = new Set(
    getDb().prepare('SELECT user_id FROM progress WHERE lesson_id = ?').all(lesson.id).map(r => r.user_id)
  );
  return listParticipants()
    .filter(p => p.dms_enabled && !(p.last_nudged_at && p.last_nudged_at > cutoff))
    .filter(p => !done.has(p.user_id))
    .map(p => ({ ...p, lesson, streak: currentStreak(p.user_id) }));
}

export function logNudge(userId, kind) {
  getDb().prepare('INSERT INTO nudges_log (user_id, kind, sent_at) VALUES (?, ?, ?)').run(userId, kind, nowIso());
  getDb().prepare('UPDATE participants SET last_nudged_at = ? WHERE user_id = ?').run(nowIso(), userId);
}

// ---------- books & study groups ----------
export function addBook({ title, totalPages = 100 }) {
  const r = getDb().prepare('INSERT INTO books (title, total_pages) VALUES (?, ?)')
    .run(String(title).trim(), Math.max(1, Math.round(+totalPages) || 100));
  return Number(r.lastInsertRowid);
}

export function listBooks() {
  return getDb().prepare('SELECT * FROM books ORDER BY id DESC').all();
}

export function getBook(id) {
  return getDb().prepare('SELECT * FROM books WHERE id = ?').get(id);
}

export function removeBook(id) {
  // groups reading this book end with it
  getDb().prepare("UPDATE study_groups SET status = 'ended' WHERE book_id = ?").run(id);
  return !!getDb().prepare('DELETE FROM books WHERE id = ?').run(id);
}

// member marks the page they reached; hitting the end finishes the book
export function setBookProgress(userId, bookId, page) {
  const book = getBook(bookId);
  if (!book) return null;
  const p = Math.max(0, Math.min(Math.round(+page) || 0, book.total_pages));
  const finished = p >= book.total_pages ? 1 : 0;
  const db = getDb();
  db.prepare(`
    INSERT INTO book_progress (book_id, user_id, page, finished, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(book_id, user_id) DO UPDATE SET page = excluded.page, finished = excluded.finished, updated_at = excluded.updated_at
  `).run(bookId, userId, p, finished, nowIso());
  return { book, page: p, finished: !!finished };
}

// one member's shelf: every book with their page / finished status
export function bookShelf(userId) {
  const prog = new Map(
    getDb().prepare('SELECT book_id, page, finished, updated_at FROM book_progress WHERE user_id = ?').all(userId)
      .map(r => [r.book_id, r])
  );
  return listBooks().map(b => ({
    id: b.id, title: b.title, total_pages: b.total_pages,
    page: prog.get(b.id)?.page ?? 0,
    finished: !!(prog.get(b.id)?.finished),
    updated_at: prog.get(b.id)?.updated_at ?? null,
  }));
}

// academy-wide book stats for the owner's table
export function bookStats() {
  const rows = getDb().prepare(`
    SELECT b.id, b.title, b.total_pages, b.pdf_msg_id, b.pdf_name, b.pdf_size, b.genre,
      COUNT(bp.user_id) AS readers,
      AVG(CAST(bp.page AS REAL) / b.total_pages) AS avg_frac,
      SUM(bp.finished) AS finished
    FROM books b LEFT JOIN book_progress bp ON bp.book_id = b.id
    GROUP BY b.id ORDER BY b.id DESC
  `).all();
  return rows.map(r => ({
    ...r, readers: r.readers ?? 0, finished: r.finished ?? 0,
    has_pdf: !!r.pdf_msg_id,
    avg_pct: r.avg_frac != null ? Math.round(r.avg_frac * 100) : 0,
  }));
}

// ---------- PDF library (books downloadable from the member dashboard) ----------
export function setBookPdf(bookId, { msgId, name, size, genre = null }) {
  getDb().prepare('UPDATE books SET pdf_msg_id = ?, pdf_name = ?, pdf_size = ?, genre = COALESCE(?, genre) WHERE id = ?')
    .run(msgId, name, size, genre, bookId);
}

export function clearBookPdf(bookId) {
  getDb().prepare('UPDATE books SET pdf_msg_id = NULL, pdf_name = NULL, pdf_size = NULL WHERE id = ?').run(bookId);
}

// find a book by (fuzzy) title — for the /pdf command
export function findBookByTitle(q) {
  const needle = String(q ?? '').trim();
  if (!needle) return null;
  const all = listBooks();
  return all.find(b => b.title === needle)
    ?? all.find(b => b.title.includes(needle))
    ?? all.find(b => needle.includes(b.title))
    ?? null;
}

export function createGroup({ title = '', bookId }) {
  const book = getBook(bookId);
  if (!book) throw new Error('الكتاب غير موجود.');
  const r = getDb().prepare('INSERT INTO study_groups (title, book_id) VALUES (?, ?)')
    .run(String(title ?? '').trim() || book.title, bookId);
  return Number(r.lastInsertRowid);
}

export function listGroups({ activeOnly = true } = {}) {
  const sql = activeOnly
    ? "SELECT g.*, b.title AS book_title, b.total_pages FROM study_groups g JOIN books b ON b.id = g.book_id WHERE g.status = 'active' ORDER BY g.id DESC"
    : 'SELECT g.*, b.title AS book_title, b.total_pages FROM study_groups g JOIN books b ON b.id = g.book_id ORDER BY g.id DESC';
  return getDb().prepare(sql).all();
}

export function getGroup(id) {
  return getDb().prepare(
    'SELECT g.*, b.title AS book_title, b.total_pages FROM study_groups g JOIN books b ON b.id = g.book_id WHERE g.id = ?'
  ).get(id);
}

export function endGroup(id) {
  getDb().prepare("UPDATE study_groups SET status = 'ended' WHERE id = ?").run(id);
}

export function joinGroup(groupId, userId, displayName = '') {
  upsertParticipant(userId, displayName);
  getDb().prepare('INSERT OR IGNORE INTO study_group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)')
    .run(groupId, userId, nowIso());
}

export function leaveGroup(groupId, userId) {
  getDb().prepare('DELETE FROM study_group_members WHERE group_id = ? AND user_id = ?').run(groupId, userId);
}

// group roster: every member's page in this group's book, furthest first
export function groupRoster(groupId) {
  const g = getGroup(groupId);
  if (!g) return null;
  const members = getDb().prepare('SELECT user_id, joined_at FROM study_group_members WHERE group_id = ?').all(groupId);
  const prog = new Map(
    getDb().prepare('SELECT user_id, page, finished, updated_at FROM book_progress WHERE book_id = ?').all(g.book_id)
      .map(r => [r.user_id, r])
  );
  return {
    ...g,
    roster: members.map(m => {
      const p = prog.get(m.user_id);
      return {
        user_id: m.user_id,
        name: getParticipant(m.user_id)?.display_name || m.user_id,
        page: p?.page ?? 0,
        total_pages: g.total_pages,
        finished: !!(p?.finished),
        updated_at: p?.updated_at ?? null,
      };
    }).sort((a, b) => b.page - a.page || a.name.localeCompare(b.name)),
  };
}

// ---------- per-course notification opt-in ----------
export function toggleCourseSub(courseId, userId, displayName = '') {
  const db = getDb();
  const has = db.prepare('SELECT 1 FROM course_subs WHERE course_id = ? AND user_id = ?').get(courseId, userId);
  if (has) {
    db.prepare('DELETE FROM course_subs WHERE course_id = ? AND user_id = ?').run(courseId, userId);
    return false;
  }
  upsertParticipant(userId, displayName);
  db.prepare('INSERT OR IGNORE INTO course_subs (course_id, user_id) VALUES (?, ?)').run(courseId, userId);
  return true;
}

export function courseSubscribers(courseId) {
  return getDb().prepare('SELECT user_id FROM course_subs WHERE course_id = ?').all(courseId).map(r => r.user_id);
}

export function subscribedCourses(userId) {
  return new Set(getDb().prepare('SELECT course_id FROM course_subs WHERE user_id = ?').all(userId).map(r => r.course_id));
}

// ---------- quiz questions ----------
export function addQuestion({ courseId, lessonId = null, question, options, correctIndex = 0, xp = 10 }) {
  const opts = (options ?? []).map(o => String(o).trim()).filter(Boolean);
  if (!question?.trim() || opts.length < 2) throw new Error('السؤال يحتاج نصاً وخيارين على الأقل.');
  const idx = Math.min(Math.max(0, Math.round(+correctIndex) || 0), opts.length - 1);
  const r = getDb().prepare(
    'INSERT INTO questions (course_id, lesson_id, question, options_json, correct_index, xp) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(courseId, lessonId, question.trim(), JSON.stringify(opts), idx, Math.max(0, Math.round(+xp) || 0));
  return Number(r.lastInsertRowid);
}

export function listQuestions({ courseId = null, lessonId = null } = {}) {
  const rows = lessonId != null
    ? getDb().prepare('SELECT * FROM questions WHERE lesson_id = ? ORDER BY id').all(lessonId)
    : courseId != null
      ? getDb().prepare('SELECT * FROM questions WHERE course_id = ? ORDER BY id').all(courseId)
      : getDb().prepare('SELECT * FROM questions ORDER BY id').all();
  return rows.map(q => ({ ...q, options: JSON.parse(q.options_json) }));
}

export function getQuestion(id) {
  const q = getDb().prepare('SELECT * FROM questions WHERE id = ?').get(id);
  return q ? { ...q, options: JSON.parse(q.options_json) } : null;
}

export function removeQuestion(id) {
  return !!getDb().prepare('DELETE FROM questions WHERE id = ?').run(id);
}

// answer once per member; correct first-timers earn XP (awarded by the caller)
export function answerQuestion(userId, questionId, choice) {
  const q = getQuestion(questionId);
  if (!q) return null;
  const db = getDb();
  const existing = db.prepare('SELECT 1 FROM question_answers WHERE question_id = ? AND user_id = ?').get(questionId, userId);
  if (existing) return { question: q, correct: false, first: false, already: true };
  const correct = Math.round(+choice) === q.correct_index;
  db.prepare('INSERT INTO question_answers (question_id, user_id, correct, answered_at) VALUES (?, ?, ?, ?)')
    .run(questionId, userId, correct ? 1 : 0, nowIso());
  upsertParticipant(userId, '');
  return { question: q, correct, first: true, already: false };
}

// ---------- member management ----------
export function renameParticipant(userId, displayName) {
  getDb().prepare('UPDATE participants SET display_name = ? WHERE user_id = ?').run(String(displayName).trim(), userId);
  return getParticipant(userId);
}

// full wipe: every trace of a member across all tables (+ their private channel id for the caller to delete)
export function removeMember(userId) {
  const db = getDb();
  const p = getParticipant(userId);
  if (!p) return null;
  for (const sql of [
    'DELETE FROM progress WHERE user_id = ?',
    'DELETE FROM attendance WHERE user_id = ?',
    'DELETE FROM xp_events WHERE user_id = ?',
    'DELETE FROM quest_completions WHERE user_id = ?',
    'DELETE FROM book_progress WHERE user_id = ?',
    'DELETE FROM study_group_members WHERE user_id = ?',
    'DELETE FROM course_subs WHERE user_id = ?',
    'DELETE FROM question_answers WHERE user_id = ?',
    'DELETE FROM nudges_log WHERE user_id = ?',
    'DELETE FROM participants WHERE user_id = ?',
  ]) db.prepare(sql).run(userId);
  return p;
}

// ---------- overview (dashboard embed + studio state) ----------
export function overview() {
  const lesson = currentLesson();
  const allLessons = listLessons();
  const lessonCourse = new Map(allLessons.map(l => [l.id, l.course_id]));
  const futureSessions = listSessions({ future: true, limit: 200 });
  return {
    now: nowIso(),
    tz: getSetting('tz', 'UTC'),
    next_session: nextSession(),
    current_lesson: lesson,
    lessons_total: allLessons.length,
    lessons_done: allLessons.filter(l => l.status === 'done').length,
    template: getTemplate(),
    courses: listCourses().map(c => {
      const ls = allLessons.filter(l => l.course_id === c.id);
      return {
        id: c.id, title: c.title, template: c.template,
        lessons_total: ls.length,
        lessons_done: ls.filter(l => l.status === 'done').length,
        next_session: futureSessions.find(s => lessonCourse.get(s.lesson_id) === c.id) ?? null,
      };
    }),
    participants: listParticipants().length,
    leaderboard: xpLeaderboard(10).map(r => {
      const p = getParticipant(r.user_id);
      return { ...r, name: p?.display_name || r.user_id, level: levelFor(r.xp), streak: currentStreak(r.user_id) };
    }),
    active_quests: listQuests().map(q => ({ ...q, done: questCompletionCount(q.id) })),
  };
}
