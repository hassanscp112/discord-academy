import 'dotenv/config';

const env = (k, d = '') => process.env[k] ?? d;

export const config = {
  coachToken: env('COACH_TOKEN'),
  aiToken: env('AI_TOKEN'),
  guildId: env('GUILD_ID'),
  bossIds: env('BOSS_IDS').split(',').map(s => s.trim()).filter(Boolean),
  tz: env('TZ', 'UTC'),
  dbPath: env('DB_PATH', './data/academy.db'),
  port: Number(env('PORT', '8420')),
  dashPassword: env('DASH_PASSWORD'),
  apiToken: env('API_TOKEN'),
  disableDiscord: env('COACH_DISABLE_DISCORD') !== '',
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
