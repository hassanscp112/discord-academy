// AI Admin entrypoint: local planning studio + optional Discord presence
// (boss-only channel/DMs), both backed by direct Ollama on this PC.
import { Client, GatewayIntentBits, MessageFlags } from 'discord.js';
import { getDb } from '../core/db.js';
import { config } from '../core/config.js';
import { createOllama } from './ollama.js';
import { createPlanner } from './planner.js';
import { startStudio } from './studio.js';

const log = (...a) => console.log('[ai-admin]', new Date().toISOString(), ...a);

getDb();
const ollama = createOllama({ url: config.studio.ollamaUrl, model: config.studio.model });
const planner = createPlanner({
  ollama, coachApiUrl: config.studio.coachApiUrl, apiToken: config.apiToken, tz: config.tz,
});

(async () => {
  try {
    await planner.pull();
    log(`pulled state from Coach — revision ${planner.draft.revision}`);
  } catch (e) {
    log(`!! could not pull from Coach (${e.message}) — start the Coach first, then re-pull in the studio`);
  }
  if (!(await ollama.healthy())) {
    log(`!! Ollama not reachable at ${config.studio.ollamaUrl} or model "${config.studio.model}" missing`);
    log('   install: https://ollama.com  then:  OLLAMA_MODELS=E:\\Ollama\\models  ollama pull ' + config.studio.model);
  }
  startStudio({ planner, ollama });
})();

// Discord presence: answers ONLY bosses, ONLY in the admin channel or DMs.
function startDiscord() {
  if (!config.aiToken) { log('AI_TOKEN not set — Discord presence disabled (studio still works).'); return; }
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
  client.once('ready', () => log(`logged in as ${client.user.tag} (admin presence on)`));
  client.on('messageCreate', async (m) => {
    if (m.author.bot) return;
    if (!config.bossIds.includes(m.author.id)) return;
    const inAdminChannel = config.studio.adminChannel && m.channelId === config.studio.adminChannel;
    const isDm = !m.guild;
    if (!inAdminChannel && !isDm) return;
    await m.channel.sendTyping().catch(() => null);
    try {
      const reply = await planner.chat(m.content.slice(0, 2000));
      for (let i = 0; i < reply.length; i += 1900) await m.reply(reply.slice(i, i + 1900));
    } catch (e) {
      await m.reply(`⚠️ ${e.message}`).catch(() => null);
    }
  });
  client.login(config.aiToken).catch(e => log('discord login failed:', e.message));
}
startDiscord();
