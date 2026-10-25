// Shared yt-dlp flag assembly + binary locations. YouTube bot-blocks datacenter/fresh IPs
// ("Sign in to confirm you're not a bot"); a exported browser cookies file
// fixes it. Drop cookies at data/cookies.txt (or set YTDLP_COOKIES) and every
// yt-dlp spawn picks it up — checked at spawn time, no restart needed.
import { existsSync } from 'node:fs';

// yt-dlp: $YTDLP_PATH → bundled tools/ binary (the Windows .exe, or the Linux one
// scripts/start.js downloads on container hosts) → yt-dlp on PATH (tablet/Termux)
export const YTDLP = process.env.YTDLP_PATH
  || (process.platform === 'win32' ? 'tools/yt-dlp.exe' : existsSync('tools/yt-dlp') ? 'tools/yt-dlp' : 'yt-dlp');
// ffmpeg: $FFMPEG_PATH (scripts/start.js sets it when it had to fetch a static build) → PATH
export const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';

export function cookieArgs() {
  const path = process.env.YTDLP_COOKIES || 'data/cookies.txt';
  return existsSync(path) ? ['--cookies', path] : [];
}
