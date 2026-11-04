import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';

const DEFAULT_LEVELS = [
  { xp: 0, name: 'Novice', emoji: '🌱' },
  { xp: 100, name: 'Apprentice', emoji: '📘' },
  { xp: 250, name: 'Learner', emoji: '📗' },
  { xp: 450, name: 'Scholar', emoji: '🎓' },
  { xp: 700, name: 'Adept', emoji: '⭐' },
  { xp: 1000, name: 'Mentor', emoji: '🧭' },
  { xp: 1400, name: 'Master', emoji: '🏆' },
];

const DEFAULT_SETTINGS = {
  channel_dashboard: '',
  channel_admin: '',
  study_vc: '',
  ping_role: '',
  xp_attendance: '20',
  xp_completion: '50',
  xp_streak_bonus: '10',
  xp_streak_bonus_cap: '50',
  levels_json: JSON.stringify(DEFAULT_LEVELS),
  level_roles: '1',
  nudge_hour: '18',
  nudge_over_dm: '1',
  nudge_cooldown_hours: '48',
  recap_day: '0',
  recap_hour: '21',
  health_hour: '9',
  reminder_minutes_before: '30',
  missed_after_minutes: '15',
  dashboard_refresh_minutes: '5',
  weekly_template_json: '',
};

let db = null;

// Close the singleton (WAL folded back into the main file). The next getDb() reopens —
// used by the dashboard's database restore to swap the file under a running bot.
export function closeDb() {
  if (!db) return;
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch {}
  db.close();
  db = null;
}

export function getDb(path = config.dbPath) {
  if (db) return db;
  mkdirSync(dirname(path), { recursive: true });
  db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS lessons (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      position INTEGER NOT NULL,
      title TEXT NOT NULL,
      url TEXT NOT NULL DEFAULT '',
      duration_min INTEGER NOT NULL DEFAULT 60,
      status TEXT NOT NULL DEFAULT 'planned'
    );
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
      scheduled_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'scheduled',
      live_post_id TEXT,
      proposed_at TEXT,
      poll_at TEXT
    );
    CREATE TABLE IF NOT EXISTS participants (
      user_id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL DEFAULT '',
      joined_at TEXT NOT NULL,
      dms_enabled INTEGER NOT NULL DEFAULT 1,
      last_nudged_at TEXT
    );
    CREATE TABLE IF NOT EXISTS progress (
      user_id TEXT NOT NULL,
      lesson_id INTEGER NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
      completed_at TEXT NOT NULL,
      PRIMARY KEY (user_id, lesson_id)
    );
    CREATE TABLE IF NOT EXISTS attendance (
      session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      left_at TEXT,
      minutes INTEGER,
      PRIMARY KEY (session_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS xp_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS quests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      lesson_ids TEXT NOT NULL DEFAULT '[]',
      starts_at TEXT NOT NULL,
      ends_at TEXT NOT NULL,
      xp_reward INTEGER NOT NULL DEFAULT 150,
      status TEXT NOT NULL DEFAULT 'active',
      auto INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS quest_completions (
      quest_id INTEGER NOT NULL REFERENCES quests(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      completed_at TEXT NOT NULL,
      PRIMARY KEY (quest_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS nudges_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      sent_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // v2 quests: checklist items (book/lecture/course) — no XP, no lessons, no expiry
  try { db.exec("ALTER TABLE quests ADD COLUMN category TEXT NOT NULL DEFAULT 'lecture'"); } catch {}
  // v3 long videos: real video metadata on lessons, per-session start offset
  // (a 2h video with 60-min classes becomes 2 sessions, the 2nd offset 60min)
  try { db.exec('ALTER TABLE lessons ADD COLUMN video_id TEXT'); } catch {}
  try { db.exec('ALTER TABLE lessons ADD COLUMN video_duration_sec INTEGER'); } catch {}
  try { db.exec('ALTER TABLE sessions ADD COLUMN offset_min INTEGER NOT NULL DEFAULT 0'); } catch {}
  // v4 multi-course: each course owns its lessons and its own schedule cadence
  db.exec(`
    CREATE TABLE IF NOT EXISTS courses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      mode TEXT NOT NULL DEFAULT 'days',
      days TEXT NOT NULL DEFAULT '',
      every_n INTEGER NOT NULL DEFAULT 2,
      time TEXT NOT NULL DEFAULT '21:00',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  try { db.exec('ALTER TABLE lessons ADD COLUMN course_id INTEGER NOT NULL DEFAULT 0'); } catch {}
  // v5 member dashboards: each participant's private progress channel
  try { db.exec('ALTER TABLE participants ADD COLUMN private_channel_id TEXT'); } catch {}
  // v6 books + study groups: page-level reading progress and shared reading
  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      total_pages INTEGER NOT NULL DEFAULT 100,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS book_progress (
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      page INTEGER NOT NULL DEFAULT 0,
      finished INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (book_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS study_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL DEFAULT '',
      book_id INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS study_group_members (
      group_id INTEGER NOT NULL REFERENCES study_groups(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (group_id, user_id)
    );
  `);
  // v8 member library: each book gets a browsable card in a public channel
  try { db.exec('ALTER TABLE books ADD COLUMN library_msg_id TEXT'); } catch {}
  // v9 PDF library: books carry a PDF posted as a thread in the sharia forum
  try { db.exec('ALTER TABLE books ADD COLUMN pdf_msg_id TEXT'); } catch {}
  try { db.exec('ALTER TABLE books ADD COLUMN pdf_name TEXT'); } catch {}
  try { db.exec('ALTER TABLE books ADD COLUMN pdf_size INTEGER'); } catch {}
  try { db.exec('ALTER TABLE books ADD COLUMN genre TEXT'); } catch {}
  // v7 per-course notification opt-in + quiz questions
  db.exec(`
    CREATE TABLE IF NOT EXISTS course_subs (
      course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (course_id, user_id)
    );
    CREATE TABLE IF NOT EXISTS questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      course_id INTEGER NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
      lesson_id INTEGER REFERENCES lessons(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      options_json TEXT NOT NULL,
      correct_index INTEGER NOT NULL DEFAULT 0,
      xp INTEGER NOT NULL DEFAULT 10,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS question_answers (
      question_id INTEGER NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
      user_id TEXT NOT NULL,
      correct INTEGER NOT NULL,
      answered_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (question_id, user_id)
    );
  `);
  // v10 course registration: per-course Discord role + subscription card message
  try { db.exec('ALTER TABLE courses ADD COLUMN role_id TEXT'); } catch {}
  try { db.exec('ALTER TABLE courses ADD COLUMN reg_msg_id TEXT'); } catch {}
  if (db.prepare('SELECT COUNT(*) AS c FROM courses').get().c === 0) {
    // first boot on v4: one course holding all existing lessons, inheriting
    // the old global cadence (weekly_template_json) when one was saved
    let mode = 'days', days = '', everyN = 2, time = '21:00';
    try {
      const row = db.prepare("SELECT value FROM settings WHERE key = 'weekly_template_json'").get();
      const raw = row ? JSON.parse(row.value) : null;
      if (raw && typeof raw === 'object') {
        mode = raw.mode || 'days';
        days = Array.isArray(raw.days) ? raw.days.join(',') : '';
        everyN = raw.everyN || 2;
        time = raw.time || '21:00';
      }
    } catch {}
    db.prepare('INSERT INTO courses (title, position, mode, days, every_n, time) VALUES (?, 1, ?, ?, ?, ?)')
      .run('الدورة الأساسية', mode, days, everyN, time);
  }
  db.prepare('UPDATE lessons SET course_id = (SELECT MIN(id) FROM courses) WHERE course_id = 0').run();
  const ins = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) ins.run(k, v);
  return db;
}

export function getSetting(key, fallback = '') {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setSetting(key, value) {
  getDb().prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

export function allSettings() {
  return Object.fromEntries(getDb().prepare('SELECT key, value FROM settings').all().map(r => [r.key, r.value]));
}

export function getLevels() {
  try { return JSON.parse(getSetting('levels_json')); } catch { return DEFAULT_LEVELS; }
}

export function getTemplate() {
  try { return JSON.parse(getSetting('weekly_template_json')); } catch { return null; }
}
