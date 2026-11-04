// The Coach's voice presence: joins the study VC at class start and plays the
// lesson's audio (members open the video link muted — bot carries the sound).
// Long videos start mid-way via offsetSec, and the owner can pause / seek /
// re-aim the stream from the web dashboard: playback is an ffmpeg child we
// restart at the wanted position, so every control op is "respawn at X".
// With AUDIO_BACKEND=lavalink the same state machine drives a Lavalink node
// instead (lavalink.js); any Lavalink failure drops back to the ffmpeg path.
import { joinVoiceChannel, createAudioResource, createAudioPlayer, NoSubscriberBehavior, StreamType, getVoiceConnection, VoiceConnectionStatus } from '@discordjs/voice';
import { spawn } from 'node:child_process';
import { mkdirSync, existsSync, unlinkSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { getSetting } from '../core/db.js';
import { config } from '../core/config.js';
import { cookieArgs, YTDLP, FFMPEG } from './ytdlp.js';
import { pruneAudioCache } from './maintenance.js';
import { lavalinkEnabled, lavalinkPlay, lavalinkUpdate, lavalinkStop, lavalinkHasPlayer, trackIdentifiers, onLavalinkFailure } from './lavalink.js';

const CACHE_DIR = process.env.AUDIO_CACHE_DIR || 'data/cache';
const prefetching = new Set();
let player = null;
let procs = [];
let volume = 1; // remembered across streams; applied by the ffmpeg pipeline
// live playback state; position = baseSec + elapsed wall-clock (or pausedAt)
let play = null;
let lastClient = null; // for the mid-class Lavalink -> ffmpeg fallback

function cachePath(lessonId) { return join(CACHE_DIR, `lesson-${lessonId}.opus`); }

// Download the lesson audio ahead of time so class start has zero network lag.
export function prefetch(lessonId, url) {
  if (!url || prefetching.has(lessonId) || existsSync(cachePath(lessonId))) return;
  prefetching.add(lessonId);
  mkdirSync(CACHE_DIR, { recursive: true });
  const ytdlp = spawn(YTDLP, ['-f', 'bestaudio/best', '-o', '-', '--no-playlist', '--js-runtimes', 'node', ...cookieArgs(), url], { stdio: ['ignore', 'pipe', 'pipe'] });
  const ffmpeg = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn', '-ac', '2', '-ar', '48000', '-c:a', 'libopus', '-b:a', '96k', '-f', 'opus', cachePath(lessonId)], { stdio: ['pipe', 'pipe', 'pipe'] });
  swallow(ytdlp.stdout, ytdlp.stderr, ffmpeg.stdin, ffmpeg.stdout, ffmpeg.stderr, ytdlp, ffmpeg);
  const done = (ok) => {
    prefetching.delete(lessonId);
    if (!ok) { try { unlinkSync(cachePath(lessonId)); } catch {} }
    console.log(`[streamer] prefetch lesson ${lessonId}: ${ok ? 'cached' : 'failed (will stream live)'}`);
    if (ok) pruneAudioCache({ keepLessonIds: [lessonId] }); // stay inside the disk budget
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

// is audio actually going out right now (either backend)?
function audioFlowing() {
  if (play?.backend === 'lavalink') return lavalinkHasPlayer(config.guildId);
  return !!player && player.state.status === 'playing';
}

export function isStreaming() {
  return !!play && play.pausedAt == null && audioFlowing();
}

// @discordjs/voice connection + player for the built-in ffmpeg path
function joinWithFfmpegPlayer(guild, vcId) {
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
}

// Lavalink died mid-class (node down / track error): carry on with ffmpeg from
// the same second so the room never goes silent.
onLavalinkFailure(async (reason) => {
  if (play?.backend !== 'lavalink' || play.warming) return;
  const mine = play;
  const at = playerPosition() ?? 0;
  console.log(`[streamer] lavalink failed (${reason}) — switching to ffmpeg @${Math.floor(at)}s`);
  await lavalinkStop(config.guildId);
  await new Promise(r => setTimeout(r, 1500)); // let the voice leave settle before rejoining
  const guild = lastClient?.guilds?.cache?.get(config.guildId);
  const vcId = getSetting('study_vc');
  if (play !== mine || !guild || !vcId) return; // class ended meanwhile
  play.backend = 'ffmpeg';
  joinWithFfmpegPlayer(guild, vcId);
  if (play.pausedAt == null) spawnPlayback(at);
});

export async function startStream(client, { lessonId, url, sessionId = null, title = '', offsetSec = 0, durationSec = null, sessionLenSec = null }) {
  if (!url) return false;
  stopStream();
  const vcId = getSetting('study_vc');
  const guild = client?.guilds?.cache?.get(config.guildId);
  if (!vcId || !guild) return false;
  lastClient = client;
  const offset = Math.max(0, offsetSec || 0);

  // Lavalink first when enabled — it seeks YouTube natively, so no warm-up step
  if (lavalinkEnabled()) {
    const mine = play = { sessionId, lessonId, title, url, baseSec: offset, startedAt: Date.now(), pausedAt: offset, durationSec, sessionLenSec, warming: true, backend: 'lavalink' };
    const cached = existsSync(cachePath(lessonId));
    const ok = await lavalinkPlay({
      guildId: config.guildId, channelId: vcId,
      identifiers: trackIdentifiers({ cacheFile: cached ? cachePath(lessonId) : null, url, fromSec: offset }),
      fromSec: offset, endSec: sessionLenSec ? offset + sessionLenSec : null, volume,
    });
    if (play !== mine) { if (ok) await lavalinkStop(config.guildId); return false; } // class finished meanwhile
    if (ok) {
      Object.assign(play, { warming: false, pausedAt: null, startedAt: Date.now() });
      console.log(`[streamer] joined study VC via lavalink, streaming "${title}" from ${Math.floor(offset)}s`);
      return true;
    }
    console.log('[streamer] lavalink could not play — using the built-in ffmpeg player');
  }

  joinWithFfmpegPlayer(guild, vcId);
  play = { sessionId, lessonId, title, url, baseSec: 0, startedAt: 0, pausedAt: null, durationSec, sessionLenSec, warming: false, backend: 'ffmpeg' };

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

  const ffmpeg = spawn(FFMPEG, [...inArgs, ...outArgs], { stdio: ['pipe', 'pipe', 'pipe'] });
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

// start/continue audio at fromSec on whichever backend owns the class
function playFrom(fromSec) {
  if (play?.backend === 'lavalink') {
    lavalinkUpdate(config.guildId, { paused: false, positionSec: fromSec })
      .catch(e => console.log('[streamer] lavalink update failed:', e.message));
    play.baseSec = Math.max(0, fromSec);
    play.startedAt = Date.now();
  } else spawnPlayback(fromSec);
}

function silence() {
  if (play?.backend === 'lavalink') {
    lavalinkUpdate(config.guildId, { paused: true }).catch(e => console.log('[streamer] lavalink pause failed:', e.message));
  } else killProcs(); // voice connection and player stay up
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
    streaming: audioFlowing(),
    backend: play.backend,
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
      silence();
      console.log(`[streamer] paused @${Math.floor(play.pausedAt)}s`);
    }
    return { ok: true };
  }
  if (op === 'resume') {
    if (play.pausedAt != null) {
      const at = play.pausedAt;
      play.pausedAt = null;
      playFrom(at);
    }
    return { ok: true };
  }
  if (op === 'seek') {
    const d = Number(delta);
    if (!Number.isFinite(d) || d === 0) return { ok: false, error: 'قيمة تقديم غير صالحة' };
    let to = Math.max(0, pos + d);
    if (Number.isFinite(dur)) to = Math.min(to, Math.max(0, dur - 1));
    if (play.pausedAt != null) play.pausedAt = to;
    else playFrom(to);
    console.log(`[streamer] seek ${d > 0 ? '+' : ''}${d}s -> ${Math.floor(to)}s`);
    return { ok: true };
  }
  if (op === 'restart') {
    play.pausedAt = null;
    playFrom(0);
    return { ok: true };
  }
  if (op === 'volume') {
    const v = Number(value);
    if (!Number.isFinite(v) || v < 0 || v > 2) return { ok: false, error: 'مستوى صوت غير صالح' };
    volume = v;
    if (play.backend === 'lavalink') {
      lavalinkUpdate(config.guildId, { volume: v }).catch(e => console.log('[streamer] lavalink volume failed:', e.message));
    // volume rides the ffmpeg pipeline — respawn so the change is heard now
    } else if (play.pausedAt == null && player) spawnPlayback(playerPosition() ?? 0);
    return { ok: true };
  }
  return { ok: false, error: 'أمر غير معروف' };
}

export function stopStream() {
  killProcs();
  play = null;
  lavalinkStop(config.guildId).catch(() => {});
  if (player) { try { player.stop(); } catch {} }
  player = null;
  const conn = getVoiceConnection(config.guildId);
  if (conn) { try { conn.destroy(); } catch {} console.log('[streamer] left study VC'); }
}
