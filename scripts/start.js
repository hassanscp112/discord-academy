// Production entry for container hosts (bot-hosting.net, any Linux box without
// system ffmpeg/yt-dlp). Makes sure both binaries exist, then boots the Coach in
// this same process. bot-hosting.net: Entry file = scripts/start.js (or `npm start`).
//   yt-dlp: $YTDLP_PATH → yt-dlp on PATH → tools/yt-dlp (downloaded, self-updated every 3 days)
//   ffmpeg: $FFMPEG_PATH → ffmpeg on PATH → tools/ffmpeg (static build, downloaded once)
// A failed download never blocks the boot — the bot runs, only class audio is affected.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, chmodSync, renameSync, rmSync, utimesSync, createWriteStream } from 'node:fs';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';

const TOOLS = resolve('tools');
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
const YTDLP_URL = {
  x64: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux',
  arm64: 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux_aarch64',
}[ARCH];
// johnvansickle static build via ffmpeg-static (includes libopus); pinned for reproducibility
const FFMPEG_URL = `https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-linux-${ARCH}.gz`;
const YTDLP_UPDATE_DAYS = 3; // YouTube changes break old yt-dlp builds within weeks

const log = (...a) => console.log('[start]', ...a);
const works = (cmd, args) => spawnSync(cmd, args, { stdio: 'ignore', timeout: 30000 }).status === 0;

async function download(url, dest, { gunzip = false } = {}) {
  const part = `${dest}.part`;
  log(`downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300000) });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const steps = [Readable.fromWeb(res.body)];
  if (gunzip) steps.push(createGunzip());
  steps.push(createWriteStream(part));
  try { await pipeline(...steps); } catch (e) { rmSync(part, { force: true }); throw e; }
  renameSync(part, dest);
  chmodSync(dest, 0o755);
  log(`saved ${dest} (${(statSync(dest).size / 1048576).toFixed(1)} MB)`);
}

async function ensureYtdlp() {
  if (process.env.YTDLP_PATH) return log(`yt-dlp: $YTDLP_PATH = ${process.env.YTDLP_PATH}`);
  const local = resolve(TOOLS, 'yt-dlp');
  if (!existsSync(local) && works('yt-dlp', ['--version'])) return log('yt-dlp: using PATH');
  if (!existsSync(local)) await download(YTDLP_URL, local);
  else if ((Date.now() - statSync(local).mtimeMs) / 86400000 > YTDLP_UPDATE_DAYS) {
    log('yt-dlp: self-updating');
    spawnSync(local, ['-U'], { stdio: 'inherit', timeout: 120000 });
    try { utimesSync(local, new Date(), new Date()); } catch {} // don't re-run -U on every boot
  }
  process.env.YTDLP_PATH = local;
  log(`yt-dlp: ${local} ${works(local, ['--version']) ? 'OK' : 'NOT RUNNABLE'}`);
}

async function ensureFfmpeg() {
  if (process.env.FFMPEG_PATH) return log(`ffmpeg: $FFMPEG_PATH = ${process.env.FFMPEG_PATH}`);
  if (works('ffmpeg', ['-version'])) return log('ffmpeg: using PATH');
  const local = resolve(TOOLS, 'ffmpeg');
  if (!existsSync(local)) await download(FFMPEG_URL, local, { gunzip: true });
  process.env.FFMPEG_PATH = local;
  const enc = spawnSync(local, ['-hide_banner', '-encoders'], { encoding: 'utf8', timeout: 30000 });
  if (enc.status !== 0) log('ffmpeg: NOT RUNNABLE —', (enc.stderr || enc.error?.message || '').slice(0, 200));
  else log(`ffmpeg: ${local} OK${enc.stdout.includes('libopus') ? '' : ' — WARNING: no libopus encoder'}`);
}

// Image cards need a Chromium. Hosts without one (bot-hosting.net) get Chrome's headless
// shell under tools/chrome — puppeteer-core's own downloader, same build puppeteer tests with.
async function ensureBrowser() {
  if (process.env.BROWSER_PATH) return log(`browser: $BROWSER_PATH = ${process.env.BROWSER_PATH}`);
  const system = ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find(p => existsSync(p));
  if (system) return log(`browser: ${system}`);
  const B = await import('@puppeteer/browsers');
  const cacheDir = resolve(TOOLS, 'chrome');
  const platform = B.detectBrowserPlatform();
  let installed = (await B.getInstalledBrowsers({ cacheDir })).find(b => b.browser === B.Browser.CHROMEHEADLESSSHELL);
  if (!installed) {
    const buildId = await B.resolveBuildId(B.Browser.CHROMEHEADLESSSHELL, platform, 'stable');
    log(`downloading chrome-headless-shell ${buildId} (for image cards)`);
    installed = await B.install({ browser: B.Browser.CHROMEHEADLESSSHELL, buildId, cacheDir, platform });
  }
  process.env.BROWSER_PATH = installed.executablePath;
  log(`browser: ${installed.executablePath} ${works(installed.executablePath, ['--version']) ? 'OK' : 'NOT RUNNABLE'}`);
}

// Cards use emoji (📖 🔔 …); minimal containers ship no emoji font → empty boxes.
// fontconfig reads ~/.local/share/fonts, so Chromium picks it up with no config.
async function ensureEmojiFont() {
  const dir = resolve(process.env.HOME || TOOLS, '.local/share/fonts');
  const font = resolve(dir, 'NotoColorEmoji.ttf');
  if (existsSync(font)) return log('emoji font: OK');
  const fc = spawnSync('fc-list', [':charset=1f4d6'], { encoding: 'utf8', timeout: 15000 });
  if (fc.status === 0 && fc.stdout.trim()) return log('emoji font: system');
  mkdirSync(dir, { recursive: true });
  await download('https://raw.githubusercontent.com/googlefonts/noto-emoji/main/2D/fonts/NotoColorEmoji.ttf', font);
  spawnSync('fc-cache', ['-f', dir], { stdio: 'ignore', timeout: 60000 });
}

if (process.platform !== 'win32') {
  mkdirSync(TOOLS, { recursive: true });
  for (const step of [ensureYtdlp, ensureFfmpeg, ensureBrowser, ensureEmojiFont]) {
    try { await step(); } catch (e) { log(`${step.name} failed: ${e.message} — continuing without it`); }
  }
}
await import('../src/coach/index.js');
