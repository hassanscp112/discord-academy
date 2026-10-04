// Domain logic for the academy. Pure functions on the SQLite DB — no Discord
// here. Both the Coach and the AI Admin studio build on this.
import { getDb, getSetting, setSetting, getTemplate, getLevels } from './db.js';
import { nextSlots } from './time.js';

const nowIso = () => new Date().toISOString();

// ---------- lessons ----------
export function addLesson({ title, url = '', durationMin = 60, position = null }) {
  const db = getDb();
  const max = db.prepare('SELECT COALESCE(MAX(position), 0) AS p FROM lessons').get().p;
  const pos = position ?? max + 1;
  db.prepare('UPDATE lessons SET position = position + 1 WHERE position >= ?').run(pos);
  const r = db.prepare('INSERT INTO lessons (position, title, url, duration_min) VALUES (?, ?, ?, ?)')
    .run(pos, title, url, durationMin);
  return r.lastInsertRowid;
}

export function listLessons() {
  return getDb().prepare('SELECT * FROM lessons ORDER BY position').all();
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

// ---------- schedule ----------
export function setTemplate({ days, time }) {
  setSetting('weekly_template_json', JSON.stringify({ days, time }));
}

export function clearTemplate() {
  setSetting('weekly_template_json', '');
}

// Generate sessions for the next `count` planned lessons into upcoming
// template slots. Returns the created session rows.
export function generateSchedule({ count = null, from = new Date() } = {}) {
  const template = getTemplate();
  if (!template) throw new Error('No weekly template set — use /schedule template first.');
  const planned = listLessons().filter(l => l.status !== 'done' && l.status !== 'skipped')
    .filter(l => !sessionForLesson(l.id));
  if (!planned.length) return [];
  const wanted = count ?? planned.length;
  const slots = nextSlots(template, from, wanted, getSetting('tz', 'UTC'));
  if (slots.length < wanted) throw new Error(`Template only yielded ${slots.length} slots for ${wanted} lessons.`);
  const ins = getDb().prepare('INSERT INTO sessions (lesson_id, scheduled_at) VALUES (?, ?)');
  const created = [];
  planned.slice(0, wanted).forEach((lesson, i) => {
    const r = ins.run(lesson.id, slots[i].toISOString());
    created.push({ id: Number(r.lastInsertRowid), lesson_id: lesson.id, scheduled_at: slots[i].toISOString(), status: 'scheduled' });
  });
  return created;
}

export function setSession(sessionId, isoDate) {
  getDb().prepare("UPDATE sessions SET scheduled_at = ?, status = 'scheduled', proposed_at = NULL WHERE id = ?")
    .run(new Date(isoDate).toISOString(), sessionId);
}

// Move a session to the next free template slot after `after`.
export function pushToNextSlot(sessionId, after = new Date()) {
  const template = getTemplate();
  if (!template) throw new Error('No weekly template set.');
  const session = getSession(sessionId);
  const slots = nextSlots(template, after, 4, getSetting('tz', 'UTC'));
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

// ---------- quests ----------
export function createQuest({ title, description = '', lessonIds = [], startsAt, endsAt, xpReward = null, auto = false }) {
  const r = getDb().prepare(
    'INSERT INTO quests (title, description, lesson_ids, starts_at, ends_at, xp_reward, auto) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(title, description, JSON.stringify(lessonIds), startsAt, endsAt, xpReward ?? Number(getSetting('xp_quest', '150')), auto ? 1 : 0);
  return Number(r.lastInsertRowid);
}

export function listQuests({ activeOnly = true } = {}) {
  const sql = activeOnly ? "SELECT * FROM quests WHERE status = 'active' ORDER BY ends_at" : 'SELECT * FROM quests ORDER BY ends_at DESC';
  return getDb().prepare(sql).all().map(q => ({ ...q, lesson_ids: JSON.parse(q.lesson_ids) }));
}

export function endQuest(questId) {
  getDb().prepare("UPDATE quests SET status = 'ended' WHERE id = ?").run(questId);
}

export function questCompletedBy(questId, userId) {
  return !!getDb().prepare('SELECT 1 FROM quest_completions WHERE quest_id = ? AND user_id = ?').get(questId, userId);
}

export function tryCompleteQuest(questId, userId) {
  const quest = getDb().prepare('SELECT * FROM quests WHERE id = ?').get(questId);
  if (!quest || quest.status !== 'active') return null;
  const lessonIds = JSON.parse(quest.lesson_ids);
  if (!lessonIds.length) return null;
  const done = getDb().prepare(
    `SELECT COUNT(*) AS c FROM progress WHERE user_id = ? AND lesson_id IN (${lessonIds.map(() => '?').join(',')})`
  ).get(userId, ...lessonIds).c;
  if (done < lessonIds.length) return null;
  if (questCompletedBy(questId, userId)) return null;
  if (new Date(quest.ends_at).getTime() < Date.now()) return null;
  getDb().prepare('INSERT INTO quest_completions (quest_id, user_id, completed_at) VALUES (?, ?, ?)').run(questId, userId, nowIso());
  const { total } = awardXp(userId, quest.xp_reward, 'quest');
  return { quest, total, level: levelFor(total) };
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

// ---------- overview (dashboard embed + studio state) ----------
export function overview() {
  const lesson = currentLesson();
  return {
    now: nowIso(),
    tz: getSetting('tz', 'UTC'),
    next_session: nextSession(),
    current_lesson: lesson,
    lessons_total: listLessons().length,
    lessons_done: listLessons().filter(l => l.status === 'done').length,
    template: getTemplate(),
    participants: listParticipants().length,
    leaderboard: xpLeaderboard(10).map(r => {
      const p = getParticipant(r.user_id);
      return { ...r, name: p?.display_name || r.user_id, level: levelFor(r.xp), streak: currentStreak(r.user_id) };
    }),
    active_quests: listQuests(),
  };
}
