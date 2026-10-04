// Logs in with the Coach token and prints every guild the bot is in,
// plus the guild owner id (that's your BOSS_IDS entry). No server changes.
import 'dotenv/config';
import { Client, GatewayIntentBits } from 'discord.js';
import { config } from '../src/core/config.js';

if (!config.coachToken) { console.error('Set COACH_TOKEN in .env first.'); process.exit(1); }
const c = new Client({ intents: [GatewayIntentBits.Guilds] });
c.once('ready', async () => {
  console.log(`Logged in as ${c.user.tag}`);
  for (const g of c.guilds.cache.values()) {
    console.log(`GUILD_ID=${g.id}  name="${g.name}"  ownerUserId=${g.ownerId}`);
  }
  if (!c.guilds.cache.size) console.log('(bot is in no servers yet — open the invite URL first)');
  process.exit(0);
});
c.login(config.coachToken).catch(e => { console.error('login failed:', e.message); process.exit(1); });
setTimeout(() => { console.error('timeout'); process.exit(1); }, 20000);
