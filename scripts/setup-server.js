// One-shot server bootstrap: creates #academy-hall, the study voice room,
// the @Students role, level roles, wires Coach settings, posts the dashboard.
// Requires the bot to have Manage Channels + Manage Roles (invite updated).
import { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits } from 'discord.js';
import 'dotenv/config';
import { config } from '../src/core/config.js';
import { setSetting, getSetting } from '../src/core/db.js';
import { buildDashboardEmbed } from '../src/coach/dashboard.js';
import { ensureLevelRoles } from '../src/coach/gamification.js';

if (!config.coachToken || !config.guildId) { console.error('Set COACH_TOKEN and GUILD_ID first.'); process.exit(1); }

const c = new Client({ intents: [GatewayIntentBits.Guilds] });
c.once('ready', async () => {
  try {
    const guild = c.guilds.cache.get(config.guildId);
    if (!guild) throw new Error(`guild ${config.guildId} not found`);
    console.log(`Setting up ${guild.name}...`);

    // role: Students (pingable)
    let students = guild.roles.cache.find(r => r.name === 'Students');
    if (!students) {
      students = await guild.roles.create({ name: 'Students', mentionable: true, color: 0x5865f2 });
      console.log('created role: Students');
    } else console.log('role exists: Students');

    // channel: academy-hall
    let hall = guild.channels.cache.find(ch => ch.name === 'academy-hall' && ch.type === ChannelType.GuildText);
    if (!hall) {
      hall = await guild.channels.create({ name: 'academy-hall', type: ChannelType.GuildText, reason: 'Academy dashboard + announcements' });
      console.log('created channel: #' + hall.name);
    } else console.log('channel exists: #' + hall.name);

    // channel: study voice room
    let vc = guild.channels.cache.find(ch => ch.name === '🔊-study-room' && ch.type === ChannelType.GuildVoice);
    if (!vc) {
      vc = await guild.channels.create({ name: '🔊-study-room', type: ChannelType.GuildVoice, reason: 'Academy study sessions' });
      console.log('created channel: ' + vc.name);
    } else console.log('channel exists: ' + vc.name);

    // level roles
    await ensureLevelRoles(guild);
    console.log('level roles ensured');

    // wire settings
    setSetting('channel_dashboard', hall.id);
    setSetting('study_vc', vc.id);
    setSetting('ping_role', students.id);
    console.log(`settings wired: dashboard=${hall.id} vc=${vc.id} role=${students.id}`);

    // post the dashboard embed (fresh, even if an old one exists)
    const old = [...(await hall.messages.fetch({ limit: 30 })).values()]
      .find(m => m.author?.bot && m.embeds?.some(e => e.footer?.text?.startsWith('ACADEMY_DASH')));
    if (old) await old.delete().catch(() => null);
    const msg = await hall.send({ embeds: [buildDashboardEmbed()] });
    await msg.pin().catch(() => null);
    await hall.send(`🎓 **The academy is open!** This board updates itself. First thing: run the first session whenever you're ready — I'll handle reminders, attendance, and XP.`);

    console.log('DONE — dashboard is live in #' + hall.name);
    process.exit(0);
  } catch (e) {
    console.error('setup failed:', e.message);
    process.exit(1);
  }
});
c.login(config.coachToken).catch(e => { console.error('login failed:', e.message); process.exit(1); });
setTimeout(() => { console.error('timeout'); process.exit(1); }, 30000);
