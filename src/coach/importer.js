// Reads course structure out of YouTube via yt-dlp: playlists become lesson
// lists, single videos give their real duration (needed for auto-splitting).
import { spawn } from 'node:child_process';
import { cookieArgs } from './ytdlp.js';

const YTDLP = process.env.YTDLP_PATH ?? 'tools/yt-dlp.exe';

function runYtdlp(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const p = spawn(YTDLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const timer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} reject(new Error('yt-dlp timed out')); }, timeoutMs);
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => err += d);
    p.on('error', e => { clearTimeout(timer); reject(e); });
    p.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(String(err || out).split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300)));
      else resolve(out);
    });
  });
}

const entryUrl = e => e.url || (e.id ? `https://www.youtube.com/watch?v=${e.id}` : null);

// Playlist URL -> { title, count, entries: [{videoId, title, durationSec, url}] }
export async function fetchPlaylist(url) {
  const raw = await runYtdlp(['--flat-playlist', '--no-warnings', ...cookieArgs(), '-J', url], 120000);
  let j;
  try { j = JSON.parse(raw); } catch { throw new Error('yt-dlp returned unreadable metadata'); }
  const rawEntries = j.entries?.length ? j.entries : (j.id ? [j] : []); // single video URL also works
  const entries = rawEntries.map(e => ({
    videoId: e.id ?? null,
    title: e.title?.trim() || `Video ${e.id ?? ''}`.trim(),
    durationSec: Number.isFinite(e.duration) ? Math.round(e.duration) : null,
    url: entryUrl(e),
  })).filter(e => e.url);
  if (!entries.length) throw new Error('no videos found at that link');
  return { title: j.title ?? null, count: j.playlist_count ?? entries.length, entries };
}

// Single video URL -> { videoId, title, durationSec } (best effort)
export async function fetchVideoMeta(url) {
  const raw = await runYtdlp(['--no-playlist', '--no-warnings', ...cookieArgs(), '-J', url], 20000);
  const j = JSON.parse(raw);
  return {
    videoId: j.id ?? null,
    title: j.title ?? null,
    durationSec: Number.isFinite(j.duration) ? Math.round(j.duration) : null,
  };
}
