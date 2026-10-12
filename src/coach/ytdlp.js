// Shared yt-dlp flag assembly. YouTube bot-blocks datacenter/fresh IPs
// ("Sign in to confirm you're not a bot"); a exported browser cookies file
// fixes it. Drop cookies at data/cookies.txt (or set YTDLP_COOKIES) and every
// yt-dlp spawn picks it up — checked at spawn time, no restart needed.
import { existsSync } from 'node:fs';

export function cookieArgs() {
  const path = process.env.YTDLP_COOKIES || 'data/cookies.txt';
  return existsSync(path) ? ['--cookies', path] : [];
}
