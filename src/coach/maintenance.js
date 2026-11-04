// Keeps a small container host healthy without anyone logging in:
//  - daily database backup: kept locally (7 days) + sent to the owner by DM
//  - audio cache trimmed to a size budget (the free plan has 1.5 GB of disk)
//  - database restore + cookies upload for the dashboard (no SFTP needed)
//  - a status snapshot for the dashboard's «النظام» panel
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, renameSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import { AttachmentBuilder } from 'discord.js';
import * as A from '../core/academy.js';
import { getDb, closeDb, getSetting, setSetting } from '../core/db.js';
import { config } from '../core/config.js';
import { cardRendererAvailable } from './card.js';

// both overridable so the test suite never touches real data
const BACKUP_DIR = process.env.BACKUP_DIR || 'data/backups';
const CACHE_DIR = process.env.AUDIO_CACHE_DIR || 'data/cache';
const COOKIES = process.env.YTDLP_COOKIES || 'data/cookies.txt';
const KEEP_BACKUPS = 7;
const DM_LIMIT_BYTES = 9.5 * 1048576; // Discord's 10 MB upload cap for bots

const dateInTz = (now = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: config.tz }).format(now);
const hourInTz = (now = new Date()) =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone: config.tz, hour: '2-digit', hour12: false }).format(now));
const mb = bytes => Math.round(bytes / 104857.6) / 10;

// ---------- backups ----------

// consistent snapshot of the live DB (VACUUM INTO is safe while the bot writes)
export function makeBackup(label = dateInTz()) {
  mkdirSync(BACKUP_DIR, { recursive: true });
  const path = join(BACKUP_DIR, `academy-${label}.db`);
  rmSync(path, { force: true });
  getDb().exec(`VACUUM INTO '${path.replace(/'/g, "''")}'`);
  setSetting('backup_last_at', new Date().toISOString());
  pruneBackups();
  return path;
}

function pruneBackups() {
  const files = listBackups();
  for (const f of files.slice(KEEP_BACKUPS)) rmSync(join(BACKUP_DIR, f.name), { force: true });
}

export function listBackups() {
  if (!existsSync(BACKUP_DIR)) return [];
  return readdirSync(BACKUP_DIR)
    .filter(n => n.endsWith('.db'))
    .map(name => ({ name, ...statSync(join(BACKUP_DIR, name)) }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map(f => ({ name: f.name, size: f.size, at: new Date(f.mtimeMs).toISOString() }));
}

// once a day at backup_hour (default 4 AM academy time): snapshot + DM to the owner
export async function backupTick({ bus, now = new Date() } = {}) {
  if (hourInTz(now) !== Number(getSetting('backup_hour', '4'))) return;
  if (getSetting('backup_last_run') === dateInTz(now)) return;
  setSetting('backup_last_run', dateInTz(now));
  try {
    const path = makeBackup(dateInTz(now));
    const gz = gzipSync(readFileSync(path));
    const o = A.overview();
    const summary = `${o.participants} عضو · ${o.courses.length} دورة · ${o.lessons_total} درس`;
    if (gz.length <= DM_LIMIT_BYTES) {
      await bus.bossDm({
        content: `🗄️ **نسخة احتياطية يومية** — ${dateInTz(now)}\n${summary}\nاحتفظ بها؛ تُستعاد من لوحة التحكم ← الإعدادات ← النظام.`,
        files: [new AttachmentBuilder(gz, { name: `academy-${dateInTz(now)}.db.gz` })],
      });
    } else {
      await bus.bossDm({ content: `🗄️ نسخة احتياطية يومية محفوظة على الخادم (${mb(gz.length)}MB — أكبر من حد ديسكورد). حمّلها من لوحة التحكم.` });
    }
    console.log(`[maintenance] backup ${path} (${mb(gz.length)}MB gz)`);
  } catch (e) {
    console.log('[maintenance] backup failed:', e.message);
    await bus.bossDm({ content: `⚠️ فشل النسخ الاحتياطي اليومي: \`${e.message.slice(0, 200)}\`` }).catch(() => {});
  }
}

// ---------- restore (dashboard upload) ----------

const REQUIRED_TABLES = ['lessons', 'sessions', 'participants', 'settings'];

// validate an uploaded file really is an academy database, then swap it in under the
// running bot. The current DB is kept as data/backups/academy-before-restore-*.db.
export function restoreDatabase(buf) {
  if (!buf?.length || buf.subarray(0, 16).toString('latin1') !== 'SQLite format 3\0') {
    return { ok: false, error: 'الملف ليس قاعدة بيانات SQLite.' };
  }
  mkdirSync(BACKUP_DIR, { recursive: true });
  const incoming = join(BACKUP_DIR, 'incoming-restore.db');
  writeFileSync(incoming, buf);
  try {
    const probe = new DatabaseSync(incoming, { readOnly: true });
    const tables = new Set(probe.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name));
    const lessons = tables.has('lessons') ? probe.prepare('SELECT COUNT(*) n FROM lessons').get().n : 0;
    const members = tables.has('participants') ? probe.prepare('SELECT COUNT(*) n FROM participants').get().n : 0;
    probe.close();
    const missing = REQUIRED_TABLES.filter(t => !tables.has(t));
    if (missing.length) { rmSync(incoming, { force: true }); return { ok: false, error: `ليست قاعدة بيانات الأكاديمية (ينقصها: ${missing.join('، ')}).` }; }

    const safety = makeBackup(`before-restore-${Date.now()}`);
    closeDb();
    for (const ext of ['-wal', '-shm']) rmSync(config.dbPath + ext, { force: true });
    renameSync(incoming, config.dbPath);
    getDb(); // reopen + run any pending migrations on the restored file
    return { ok: true, lessons, members, safety };
  } catch (e) {
    rmSync(incoming, { force: true });
    getDb(); // make sure the bot keeps a working handle whatever happened
    return { ok: false, error: `تعذّرت الاستعادة: ${e.message}` };
  }
}

// ---------- yt-dlp cookies (dashboard upload) ----------

export function saveCookies(text) {
  const body = String(text ?? '').replace(/^﻿/, '');
  // Netscape cookie file: tab-separated lines; must carry YouTube cookies to be useful
  const lines = body.split(/\r?\n/).filter(l => l && !l.startsWith('#'));
  const valid = lines.filter(l => l.split('\t').length >= 7);
  if (!valid.length) return { ok: false, error: 'ليس ملف كوكيز بصيغة Netscape (cookies.txt).' };
  if (!valid.some(l => /youtube\.com|google\.com/.test(l))) return { ok: false, error: 'الملف لا يحتوي كوكيز يوتيوب.' };
  mkdirSync('data', { recursive: true });
  writeFileSync(COOKIES, body.endsWith('\n') ? body : body + '\n');
  setSetting('cookies_uploaded_at', new Date().toISOString());
  return { ok: true, count: valid.length };
}

// ---------- audio cache budget ----------

// Keep data/cache under cache_max_mb (default 600): drop the oldest files first, never
// one that's playing or scheduled within the next 14 days.
export function pruneAudioCache({ keepLessonIds = [] } = {}) {
  if (!existsSync(CACHE_DIR)) return { removed: 0, sizeMb: 0 };
  const budget = Number(getSetting('cache_max_mb', '600')) * 1048576;
  const soon = Date.now() + 14 * 86400000;
  const keep = new Set([
    ...keepLessonIds.map(Number),
    ...A.listSessions({ future: true })
      .filter(s => s.status === 'live' || new Date(s.scheduled_at).getTime() < soon)
      .map(s => s.lesson_id),
  ]);
  const files = readdirSync(CACHE_DIR)
    .filter(n => /^lesson-\d+\.opus$/.test(n))
    .map(n => ({ n, id: Number(n.match(/\d+/)[0]), ...statSync(join(CACHE_DIR, n)) }))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = files.reduce((s, f) => s + f.size, 0);
  let removed = 0;
  for (const f of files) {
    if (total <= budget) break;
    if (keep.has(f.id)) continue;
    try { unlinkSync(join(CACHE_DIR, f.n)); total -= f.size; removed++; } catch {}
  }
  if (removed) console.log(`[maintenance] audio cache: removed ${removed} file(s), now ${mb(total)}MB`);
  return { removed, sizeMb: mb(total) };
}

// ---------- status for the dashboard ----------

function dirSize(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  for (const n of readdirSync(dir)) {
    try { const s = statSync(join(dir, n)); total += s.isDirectory() ? dirSize(join(dir, n)) : s.size; } catch {}
  }
  return total;
}

export function systemStatus() {
  const cookies = existsSync(COOKIES) ? statSync(COOKIES) : null;
  const db = existsSync(config.dbPath) ? statSync(config.dbPath) : null;
  return {
    cookies: cookies ? { at: getSetting('cookies_uploaded_at') || new Date(cookies.mtimeMs).toISOString(), ageDays: Math.floor((Date.now() - cookies.mtimeMs) / 86400000) } : null,
    database: { sizeMb: db ? mb(db.size) : 0 },
    backups: listBackups().slice(0, KEEP_BACKUPS),
    lastBackupAt: getSetting('backup_last_at') || null,
    cacheMb: mb(dirSize(CACHE_DIR)),
    cacheMaxMb: Number(getSetting('cache_max_mb', '600')),
    cards: cardRendererAvailable(),
    lastAudioProblem: getSetting('audio_problem_last') ? JSON.parse(getSetting('audio_problem_last')) : null,
    uptimeMin: Math.round(process.uptime() / 60),
    memoryMb: mb(process.memoryUsage().rss),
  };
}
