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
  reminder_minutes_before: '30',
  missed_after_minutes: '15',
  dashboard_refresh_minutes: '5',
  weekly_template_json: '',
};

let db = null;

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
