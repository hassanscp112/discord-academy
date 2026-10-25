// Optional Lavalink audio backend — the approach github.com/faisaljs/Groove-Music
// uses: the poru client hands playback to a Lavalink v4 server (Java), which
// decodes, seeks and mixes volume natively. Off unless AUDIO_BACKEND=lavalink.
// streamer.js still owns the class state and falls back to its own
// yt-dlp→ffmpeg pipeline whenever this backend can't play (node down, load
// failed, track error mid-class) — a silent class is the one unacceptable outcome.
import { Poru } from 'poru';
import { resolve as resolvePath } from 'node:path';
import { config } from '../core/config.js';

let poru = null;
let onFailure = null; // streamer's fallback hook: (reason) => void

const log = (...a) => console.log('[lavalink]', ...a);

export function lavalinkEnabled() {
  return config.audioBackend === 'lavalink' && !!config.lavalink.host;
}

// usable right now: initialised and at least one node connected
export function lavalinkReady() {
  return !!poru?.isActivated && poru.leastUsedNodes.length > 0;
}

export function onLavalinkFailure(fn) { onFailure = fn; }

// call once from the client 'ready' handler (poru needs client.user)
export async function initLavalink(client) {
  if (!lavalinkEnabled() || poru || !client) return;
  const { host, port, password, secure } = config.lavalink;
  poru = new Poru(client, [{ name: 'main', host, port, password, secure }], {
    library: 'discord.js',
    reconnectTimeout: 15000,
    reconnectTries: 240, // ~1 h of retries; the ffmpeg fallback covers the gap
  });
  poru.on('nodeConnect', n => log(`node ${n.name} connected (${host}:${port})`));
  poru.on('nodeDisconnect', n => {
    log(`node ${n.name} disconnected`);
    onFailure?.('node disconnected');
  });
  poru.on('nodeError', (n, e) => log(`node ${n.name} error:`, e?.message ?? e));
  // TrackExceptionEvent / TrackStuckEvent (e.g. YouTube blocked the node mid-class)
  poru.on('trackError', (_p, _t, data) => {
    log('track error:', data?.exception?.message ?? data?.type ?? 'unknown');
    onFailure?.('track error');
  });
  await poru.init();
  log('initialised — waiting for the node');
}

// Lavalink v4 /loadtracks → encoded track (null when nothing playable)
async function loadTrack(identifier) {
  const node = poru.leastUsedNodes[0];
  if (!node) return null;
  const res = await node.rest.get(`/v4/loadtracks?identifier=${encodeURIComponent(identifier)}`).catch(() => null);
  if (res?.loadType === 'track') return res.data?.encoded ?? null;
  if (res?.loadType === 'search') return res.data?.[0]?.encoded ?? null;
  if (res?.loadType === 'playlist') return res.data?.tracks?.[0]?.encoded ?? null;
  if (res?.loadType === 'error') log(`load failed for ${identifier}:`, res.data?.message ?? 'unknown');
  return null;
}

const waitFor = (cond, maxMs) => new Promise(resolve => {
  const t0 = Date.now();
  const iv = setInterval(() => {
    if (cond()) { clearInterval(iv); resolve(true); }
    else if (Date.now() - t0 > maxMs) { clearInterval(iv); resolve(false); }
  }, 250);
});

// The local cache file is only usable when Lavalink runs on THIS machine with
// `lavalink.server.sources.local: true` (LAVALINK_LOCAL_FILES=1); otherwise the
// node streams the YouTube URL itself.
// Lavalink 4.2.2 / lavaplayer 2.2.6 can't start an Ogg-Opus file mid-way
// (NPE in OpusPacketRouter on every try, tested 2026-10-25) — so parts 2+ skip
// the local file; if the URL fails too, streamer.js plays the cache via ffmpeg.
export function trackIdentifiers({ cacheFile = null, url, fromSec = 0 }) {
  const ids = [];
  if (cacheFile && config.lavalink.localFiles && fromSec === 0) ids.push(resolvePath(cacheFile));
  if (url) ids.push(url);
  return ids;
}

// Join the VC and start playing. Resolves true only when Lavalink accepted the
// track; on false nothing is left connected and the caller uses ffmpeg instead.
export async function lavalinkPlay({ guildId, channelId, identifiers, fromSec = 0, endSec = null, volume = 1 }) {
  if (!lavalinkReady()) return false;
  let encoded = null;
  for (const id of identifiers) {
    encoded = await loadTrack(id);
    if (encoded) break;
  }
  if (!encoded) return false;

  let player;
  try {
    player = poru.createConnection({ guildId, voiceChannel: channelId, textChannel: channelId, deaf: true });
  } catch (e) { log('connect failed:', e.message); return false; }
  // Discord's voice-server update must reach Lavalink before audio can flow
  if (!await waitFor(() => !!player.connection?.voice?.endpoint, 15000)) {
    log('voice handshake timed out');
    await lavalinkStop(guildId);
    return false;
  }
  const data = {
    track: { encoded },
    position: Math.max(0, Math.floor(fromSec * 1000)),
    volume: Math.round(volume * 100), // Lavalink: 100 = unity, max 1000
    paused: false,
  };
  if (endSec) data.endTime = Math.floor(endSec * 1000);
  const res = await player.node.rest.updatePlayer({ guildId, data });
  if (!res || res.error) {
    log('play rejected:', res?.message ?? res?.error ?? 'no response');
    await lavalinkStop(guildId);
    return false;
  }
  player.isPlaying = true;
  log(`playing from ${Math.floor(fromSec)}s${endSec ? ` until ${Math.floor(endSec)}s` : ''}`);
  return true;
}

// pause / resume / seek / volume in one PATCH: { paused?, positionSec?, volume? }
export async function lavalinkUpdate(guildId, { paused, positionSec, volume } = {}) {
  const player = poru?.players.get(guildId);
  if (!player) return false;
  const data = {};
  if (paused !== undefined) data.paused = paused;
  if (positionSec !== undefined) data.position = Math.max(0, Math.floor(positionSec * 1000));
  if (volume !== undefined) data.volume = Math.round(volume * 100);
  const res = await player.node.rest.updatePlayer({ guildId, data });
  if (paused !== undefined) player.isPaused = paused;
  return !!res && !res.error;
}

export function lavalinkHasPlayer(guildId) {
  return !!poru?.players.get(guildId);
}

export async function lavalinkStop(guildId) {
  const player = poru?.players.get(guildId);
  if (!player) return;
  try { await player.destroy(); } catch (e) { log('destroy:', e.message); }
}
