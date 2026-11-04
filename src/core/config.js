import 'dotenv/config';

const env = (k, d = '') => process.env[k] ?? d;

export const config = {
  coachToken: env('COACH_TOKEN'),
  aiToken: env('AI_TOKEN'),
  guildId: env('GUILD_ID'),
  bossIds: env('BOSS_IDS').split(',').map(s => s.trim()).filter(Boolean),
  // ACADEMY_TZ wins: container hosts force TZ to the node's own zone (bot-hosting.net → Europe/Helsinki)
  tz: env('ACADEMY_TZ') || env('TZ', 'UTC'),
  dbPath: env('DB_PATH', './data/academy.db'),
  // container hosts (bot-hosting.net / Pterodactyl) hand out the port as SERVER_PORT
  port: Number(env('SERVER_PORT') || env('PORT', '8420')),
  trustProxy: env('TRUST_PROXY') === '1', // behind the host's HTTPS proxy: real client IP from X-Forwarded-For
  dashPassword: env('DASH_PASSWORD'),
  apiToken: env('API_TOKEN'),
  disableDiscord: env('COACH_DISABLE_DISCORD') !== '',
  // class audio: 'ffmpeg' (built-in yt-dlp→ffmpeg player) or 'lavalink' (needs a Lavalink v4 node;
  // ffmpeg stays the automatic fallback)
  audioBackend: env('AUDIO_BACKEND', 'ffmpeg').toLowerCase(),
  lavalink: {
    host: env('LAVALINK_HOST'),
    port: Number(env('LAVALINK_PORT', '2333')),
    password: env('LAVALINK_PASSWORD', 'youshallnotpass'),
    secure: env('LAVALINK_SECURE') === '1',
    localFiles: env('LAVALINK_LOCAL_FILES') === '1', // node is on this machine and may read data/cache
  },
  studio: {
    port: Number(env('STUDIO_PORT', '8421')),
    ollamaUrl: env('OLLAMA_URL', 'http://127.0.0.1:11434'),
    model: env('OLLAMA_MODEL', 'qwen2.5:7b'),
    coachApiUrl: env('COACH_API_URL', 'http://localhost:8420'),
    adminChannel: env('AI_ADMIN_CHANNEL'),
  },
};

export function validateCoachConfig(log) {
  if (config.disableDiscord) return true;
  const missing = [];
  if (!config.coachToken) missing.push('COACH_TOKEN');
  if (!config.guildId) missing.push('GUILD_ID');
  if (!config.dashPassword) missing.push('DASH_PASSWORD');
  if (!config.apiToken) missing.push('API_TOKEN');
  if (missing.length) {
    log?.(`Missing required env vars: ${missing.join(', ')} — see .env.example`);
    return false;
  }
  return true;
}
