// The Coach's voice presence: joins the study VC at class start and plays the
// lesson's audio (members open the video link muted — bot carries the sound).
import { joinVoiceChannel, createAudioResource, createAudioPlayer, NoSubscriberBehavior, StreamType, getVoiceConnection } from '@discordjs/voice';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getSetting } from '../core/db.js';
import { config } from '../core/config.js';

const YTDLP = process.env.YTDLP_PATH ?? 'tools/yt-dlp.exe';
const VIDEOBOT = process.env.VIDEOBOT_URL ?? 'http://127.0.0.1:8422';
const CACHE_DIR = 'data/cache';
const prefetching = new Set();
let player = null;
let procs = [];

function cachePath(lessonId) { return join(CACHE_DIR, `lesson-${lessonId}.opus`); }

// Download the lesson audio ahead of time so class start has zero network lag.
export function prefetch(lessonId, url) {
  if (!url || prefetching.has(lessonId) || existsSync(cachePath(lessonId))) return;
  prefetching.add(lessonId);
  mkdirSync(CACHE_DIR, { recursive: true });
  const ytdlp = spawn(YTDLP, ['-f', 'bestaudio/best', '-o', '-', '--no-playlist', '--js-runtimes', 'node', url], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ffmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'libopus', '-b:a', '96k', '-f', 'opus', cachePath(lessonId)], { stdio: ['pipe', 'pipe', 'pipe'] });
  swallow(ytdlp.stdout, ytdlp.stderr, ffmpeg.stdin, ffmpeg.stdout, ffmpeg.stderr, ytdlp, ffmpeg);
  const done = (ok) => {
    prefetching.delete(lessonId);
    if (!ok) { try { unlinkSync(cachePath(lessonId)); } catch {} }
    console.log(`[streamer] prefetch lesson ${lessonId}: ${ok ? 'cached' : 'failed (will stream live)'}`);
  };
  ffmpeg.on('close', code => done(code === 0));
  ytdlp.stdout.pipe(ffmpeg.stdin);
}

export function clearCache(lessonId = null) {
  try {
    if (lessonId) { if (existsSync(cachePath(lessonId))) unlinkSync(cachePath(lessonId)); }
    else for (const f of readdirSync(CACHE_DIR)) unlinkSync(join(CACHE_DIR, f));
  } catch {}
}

export function cacheInfo() {
  try {
    return readdirSync(CACHE_DIR).filter(f => f.endsWith('.opus')).map(f => ({
      lessonId: Number(f.match(/(\d+)/)?.[1] ?? 0),
      mb: +(statSync(join(CACHE_DIR, f)).size / 1048576).toFixed(1),
    }));
  } catch { return []; }
}

function swallow(...streams) {
  for (const s of streams) {
    if (!s) continue;
    s.on('error', e => console.log('[streamer] stream error (ignored):', e.code ?? e.message));
  }
}

function killProcs() {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch {} }
  procs = [];
}

export function isStreaming() {
  return !!player && player.state.status === 'playing';
}

export function startStream(client, lessonId, url) {
  if (!url) return Promise.resolve(false);
  stopStream();
  // preferred path: the video sidecar pushes REAL video+audio into the VC
  return fetch(`${VIDEOBOT}/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, lessonId, channelId: getSetting('study_vc'), guildId: config.guildId }),
    signal: AbortSignal.timeout(8000),
  })
    .then(r => (r.ok ? (console.log('[streamer] video sidecar streaming lesson', lessonId), true) : Promise.reject(new Error('sidecar ' + r.status))))
    .catch(e => {
      console.log('[streamer] video sidecar unavailable (' + e.message + ') — falling back to audio-only');
      return startAudioOnly(client, lessonId, url);
    });
}

function startAudioOnly(client, lessonId, url) {
  const vcId = getSetting('study_vc');
  const guild = client?.guilds?.cache?.get(config.guildId);
  if (!vcId || !guild) return false;

  const connection = joinVoiceChannel({
    channelId: vcId,
    guildId: config.guildId,
    adapterCreator: guild.voiceAdapterCreator,
    selfDeaf: true,
  });
  swallow(connection); // voice websocket/udp blips must never crash the academy

  player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.keepPlaying } });

  // cached file if prefetched, else live yt-dlp pipe
  const cached = existsSync(cachePath(lessonId));
  let ffmpeg;
  if (cached) {
    console.log(`[streamer] streaming lesson ${lessonId} from cache`);
    ffmpeg = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-re', '-i', cachePath(lessonId), '-c:a', 'copy', '-f', 'opus', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
  } else {
    console.log(`[streamer] no cache for lesson ${lessonId} — streaming live from YouTube`);
    const ytdlp = spawn(YTDLP, ['-f', 'bestaudio/best', '-o', '-', '--no-playlist', '--js-runtimes', 'node', url], { stdio: ['ignore', 'pipe', 'pipe'] });
    ffmpeg = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-i', 'pipe:0',
      '-vn', '-ac', '2', '-ar', '48000',
      '-c:a', 'libopus', '-b:a', '96k', '-page_duration', '20000',
      '-f', 'opus', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    swallow(ytdlp.stdout, ytdlp.stderr, ytdlp, ffmpeg);
    ytdlp.stderr.on('data', d => console.log('[streamer][ytdlp]', String(d).split('\n')[0].slice(0, 160)));
    ytdlp.stdout.pipe(ffmpeg.stdin);
  }
  procs = [ffmpeg];
  swallow(ffmpeg.stdin, ffmpeg.stdout, ffmpeg.stderr, ffmpeg);
  ffmpeg.stderr.on('data', d => console.log('[streamer][ffmpeg]', String(d).split('\n')[0].slice(0, 160)));

  const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus });
  player.play(resource);
  player.on('stateChange', (o, n) => { if (n.status !== o.status) console.log('[streamer] player:', n.status); });
  player.on('error', e => { console.log('[streamer] player error:', e.message); });

  console.log('[streamer] joined study VC, streaming:', url.slice(0, 60));
  return true;
}

export function stopStream() {
  killProcs();
  fetch(`${VIDEOBOT}/stop`, { method: 'POST', signal: AbortSignal.timeout(3000) }).catch(() => {});
  if (player) { try { player.stop(); } catch {} }
  player = null;
  const conn = getVoiceConnection(config.guildId);
  if (conn) { try { conn.destroy(); } catch {} console.log('[streamer] left study VC'); }
}
