// The Coach's voice presence: joins the study VC at class start and plays the
// lesson's audio (members open the video link muted — bot carries the sound).
// Long videos start mid-way via offsetSec, and the owner can pause / seek /
// re-aim the stream from the web dashboard: playback is an ffmpeg child we
// restart at the wanted position, so every control op is "respawn at X".
import { joinVoiceChannel, createAudioResource, createAudioPlayer, NoSubscriberBehavior, StreamType, getVoiceConnection, VoiceConnectionStatus } from '@discordjs/voice';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getSetting } from '../core/db.js';
import { config } from '../core/config.js';
import { cookieArgs } from './ytdlp.js';

const YTDLP = process.env.YTDLP_PATH ?? 'tools/yt-dlp.exe';
const VIDEOBOT = process.env.VIDEOBOT_URL ?? 'http://127.0.0.1:8422';
const CACHE_DIR = 'data/cache';
const prefetching = new Set();
let player = null;
let procs = [];
let volume = 1; // remembered across streams; applied by the ffmpeg pipeline
// live playback state; position = baseSec + elapsed wall-clock (or pausedAt)
let play = null;

function cachePath(lessonId) { return join(CACHE_DIR, `lesson-${lessonId}.opus`); }

// Download the lesson audio ahead of time so class start has zero network lag.
export function prefetch(lessonId, url) {
  if (!url || prefetching.has(lessonId) || existsSync(cachePath(lessonId))) return;
  prefetching.add(lessonId);
  mkdirSync(CACHE_DIR, { recursive: true });
  const ytdlp = spawn(YTDLP, ['-f', 'bestaudio/best', '-o', '-', '--no-playlist', '--js-runtimes', 'node', ...cookieArgs(), url], { stdio: ['ignore', 'pipe', 'pipe'] });
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
  return !!play && play.pausedAt == null && !!player && player.state.status === 'playing';
}

export async function startStream(client, { lessonId, url, sessionId = null, title = '', offsetSec = 0, durationSec = null, sessionLenSec = null }) {
  if (!url) return false;
  stopStream();
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
  connection.on('stateChange', (o, n) => {
    if (n.status !== o.status) console.log('[streamer] voice connection:', n.status);
  });

  player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.keepPlaying } });
  player.on('stateChange', (o, n) => { if (n.status !== o.status) console.log('[streamer] player:', n.status); });
  player.on('error', e => console.log('[streamer] player error:', e.message));
  // THE link: without subscribing, the player plays into nothing and Discord hears silence
  connection.subscribe(player);

  play = { sessionId, lessonId, title, url, baseSec: 0, startedAt: 0, pausedAt: null, durationSec, sessionLenSec, warming: false };
  const offset = Math.max(0, offsetSec || 0);

  // Part 2+ with no cache: the live YouTube section pipe takes tens of seconds
  // (or fails) before any audio — download the full audio at full bandwidth,
  // then play from cache. Cached seeking at any offset is instant.
  if (offset > 0 && !existsSync(cachePath(lessonId))) {
    play.warming = true;
    play.baseSec = offset;
    play.startedAt = Date.now();
    play.pausedAt = offset;
    console.log(`[streamer] "${title}" from ${Math.round(offset / 60)}min has no cache — fetching full audio first`);
    const cached = await waitForPrefetch(lessonId, url, 150000);
    if (!play) return false; // class was finished while warming
    play.warming = false;
    play.pausedAt = null;
    console.log(cached
      ? `[streamer] audio cached — starting playback at ${offset}s`
      : '[streamer] prefetch failed/timed out — falling back to live section stream');
  }
  spawnPlayback(offset);
  console.log(`[streamer] joined study VC, streaming "${title}" from ${Math.floor(offset)}s`);
  return true;
}

// resolve when the prefetch finished writing the cache file (false on failure/timeout)
function waitForPrefetch(lessonId, url, maxMs) {
  return new Promise(resolve => {
    prefetch(lessonId, url);
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (!play) { clearInterval(iv); return resolve(false); } // stream stopped mid-warmup
      if (!prefetching.has(lessonId)) {
        clearInterval(iv);
        return resolve(existsSync(cachePath(lessonId)));
      }
      if (Date.now() - t0 > maxMs) { clearInterval(iv); return resolve(false); }
    }, 2000);
  });
}

// (re)build the ffmpeg pipeline so it outputs audio starting at fromSec
function spawnPlayback(fromSec) {
  killProcs();
  if (!play) return;
  const cached = existsSync(cachePath(play.lessonId));
  const inArgs = ['-hide_banner', '-loglevel', 'error'];
  let ytdlp = null;
  if (cached) {
    console.log(`[streamer] playing lesson ${play.lessonId} from cache @${Math.floor(fromSec)}s`);
    inArgs.push('-re', '-ss', String(Math.max(0, fromSec)), '-i', cachePath(play.lessonId));
  } else {
    console.log(`[streamer] no cache for lesson ${play.lessonId} — live from YouTube @${Math.floor(fromSec)}s`);
    const ytdlpArgs = ['-f', 'bestaudio/best', '-o', '-', '--no-playlist', '--js-runtimes', 'node', ...cookieArgs()];
    if (fromSec > 0) ytdlpArgs.push('--download-sections', `*${Math.floor(fromSec)}-inf`);
    ytdlpArgs.push(play.url);
    ytdlp = spawn(YTDLP, ytdlpArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    inArgs.push('-i', 'pipe:0');
  }
  const outArgs = [];
  if (play.sessionLenSec) outArgs.push('-t', String(Math.ceil(play.sessionLenSec)));
  // volume lives in the ffmpeg pipeline — pass-through copy only at unity gain
  // (inlineVolume would need an opus encoder module that isn't installed)
  if (cached && volume === 1) outArgs.push('-c:a', 'copy');
  else {
    outArgs.push('-vn', '-ac', '2', '-ar', '48000');
    if (volume !== 1) outArgs.push('-af', `volume=${volume.toFixed(2)}`);
    outArgs.push('-c:a', 'libopus', '-b:a', '96k', '-page_duration', '20000');
  }
  outArgs.push('-f', 'opus', 'pipe:1');

  const ffmpeg = spawn('ffmpeg', [...inArgs, ...outArgs], { stdio: ['pipe', 'pipe', 'pipe'] });
  procs = ytdlp ? [ytdlp, ffmpeg] : [ffmpeg];
  swallow(ffmpeg.stdin, ffmpeg.stdout, ffmpeg.stderr, ffmpeg, ytdlp);
  if (ytdlp) {
    ytdlp.stderr.on('data', d => console.log('[streamer][ytdlp]', String(d).split('\n')[0].slice(0, 160)));
    ytdlp.stdout.pipe(ffmpeg.stdin);
  }
  ffmpeg.stderr.on('data', d => console.log('[streamer][ffmpeg]', String(d).split('\n')[0].slice(0, 160)));

  const resource = createAudioResource(ffmpeg.stdout, { inputType: StreamType.OggOpus });
  player.play(resource);
  play.baseSec = Math.max(0, fromSec);
  play.startedAt = Date.now();
}

export function playerPosition() {
  if (!play) return null;
  const pos = play.pausedAt != null ? play.pausedAt : play.baseSec + (Date.now() - play.startedAt) / 1000;
  return play.durationSec ? Math.min(pos, play.durationSec) : Math.max(0, pos);
}

export function playerState() {
  if (!play) return { live: false };
  return {
    live: true,
    paused: !play.warming && play.pausedAt != null,
    buffering: play.warming,
    streaming: !!player && player.state.status === 'playing',
    sessionId: play.sessionId,
    lessonId: play.lessonId,
    title: play.title,
    positionSec: Math.floor(playerPosition() ?? 0),
    durationSec: play.durationSec,
    volume: Math.round(volume * 100) / 100,
  };
}

// op: pause | resume | seek (delta seconds, signed) | restart | volume (0..2)
export function controlPlayer(op, { delta = 0, value = null } = {}) {
  if (!play) return { ok: false, error: 'لا توجد حصة مباشرة الآن' };
  if (play.warming && op !== 'volume') return { ok: true }; // still preparing the audio
  const dur = play.durationSec ?? Infinity;
  const pos = playerPosition() ?? 0;
  if (op === 'pause') {
    if (play.pausedAt == null) {
      play.pausedAt = Math.min(pos, dur);
      killProcs(); // silence; voice connection and player stay up
      console.log(`[streamer] paused @${Math.floor(play.pausedAt)}s`);
    }
    return { ok: true };
  }
  if (op === 'resume') {
    if (play.pausedAt != null) {
      const at = play.pausedAt;
      play.pausedAt = null;
      spawnPlayback(at);
    }
    return { ok: true };
  }
  if (op === 'seek') {
    const d = Number(delta);
    if (!Number.isFinite(d) || d === 0) return { ok: false, error: 'قيمة تقديم غير صالحة' };
    let to = Math.max(0, pos + d);
    if (Number.isFinite(dur)) to = Math.min(to, Math.max(0, dur - 1));
    if (play.pausedAt != null) play.pausedAt = to;
    else spawnPlayback(to);
    console.log(`[streamer] seek ${d > 0 ? '+' : ''}${d}s -> ${Math.floor(to)}s`);
    return { ok: true };
  }
  if (op === 'restart') {
    play.pausedAt = null;
    spawnPlayback(0);
    return { ok: true };
  }
  if (op === 'volume') {
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0 || v > 2) return { ok: false, error: 'مستوى صوت غير صالح' };
    volume = v;
    // volume rides the ffmpeg pipeline — respawn so the change is heard now
    if (play.pausedAt == null && player) spawnPlayback(playerPosition() ?? 0);
    return { ok: true };
  }
  return { ok: false, error: 'أمر غير معروف' };
}

export function stopStream() {
  killProcs();
  fetch(`${VIDEOBOT}/stop`, { method: 'POST', signal: AbortSignal.timeout(3000) }).catch(() => {});
  play = null;
  if (player) { try { player.stop(); } catch {} }
  player = null;
  const conn = getVoiceConnection(config.guildId);
  if (conn) { try { conn.destroy(); } catch {} console.log('[streamer] left study VC'); }
}
