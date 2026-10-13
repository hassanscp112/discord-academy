// Coach entrypoint: Discord client (optional), engines, dashboard, web+API.
import { Client, GatewayIntentBits, ActivityType } from 'discord.js';
import { getDb, getSetting } from '../core/db.js';
import { config, validateCoachConfig } from '../core/config.js';
import { createBus } from './bus.js';
import { commandDefs, handleCommand, handleButton, handleModal, handleSelect, handleContextMenu } from './commands.js';
import { tick, finishSession } from './sessions.js';
import { startEngines } from './checkins.js';
import { refreshDashboard, invalidateDashboardCache } from './dashboard.js';
import { startWeb } from './web.js';
import { ensureLevelRoles } from './gamification.js';
import { markMemberDirty, markAllMembersDirty, refreshMemberDashboards, postOnboarding } from './memberdash.js';
import { initHealth, reportError } from './health.js';
import { syncLibrary } from './library.js';
import { syncCourseCards } from './coursereg.js';
import { warmCardRenderer } from './card.js';
import { refreshAcademyDashboard, ensureVoiceChannel, ensureHubOrder } from './acadashboard.js';
import { onUploadMessage, ensureUploadChannel, postUploadInstructions } from './uploads.js';
import * as A from '../core/academy.js';

const log = (...a) => console.log('[coach]', new Date().toISOString(), ...a);

// A 24/7 bot must survive network blips and stray errors — log loudly, keep
// running, and surface them to the owner (health module DMs + daily digest).
process.on('uncaughtException', e => { log('uncaughtException:', e?.stack ?? e); reportError('uncaughtException', e); });
process.on('unhandledRejection', e => { log('unhandledRejection:', e?.stack ?? e); reportError('unhandledRejection', e); });

if (!validateCoachConfig(log)) process.exit(1);

getDb();
// Auto-detecting PDF drops needs the Message Content intent — opt-in via env,
// because declaring it without the portal toggle would break the gateway login.
const msgIntent = process.env.COACH_MSG_INTENT === '1';
const client = config.disableDiscord ? null : new Client({
  intents: msgIntent
    ? [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers, GatewayIntentBits.MessageContent]
    : [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMembers],
});
const bus = createBus(client);

// voice attendance: record join/leave in the study VC while a session is live
function activeLiveSession() {
  return A.listSessions({ future: true }).find(s => s.status === 'live') ?? null;
}

if (client) {
  client.once('ready', async () => {
    log(`logged in as ${client.user.tag}`);
    client.user.setActivity('the academy 🎓', { type: ActivityType.Watching });
    const guild = client.guilds.cache.get(config.guildId);
    if (!guild) { log(`!! guild ${config.guildId} not found — check GUILD_ID`); }
    else {
      try {
        await guild.commands.set(commandDefs.map(c => c.toJSON()));
        log(`registered ${commandDefs.length} slash commands in ${guild.name}`);
        await ensureLevelRoles(guild).catch(e => log('role setup:', e.message));
      } catch (e) { log('command registration failed:', e.message); }
    }
    invalidateDashboardCache();
    await refreshDashboard(client, { force: true });
    // owner visibility: error DMs + daily heartbeat
    initHealth({ sendDm: content => bus.bossDm({ content }) });
    // pinned onboarding guide in the announcements channel (idempotent)
    await postOnboarding(client).catch(e => log('onboarding:', e.message));
    // member library: every book gets a browsable card in its channel
    warmCardRenderer().catch(() => {});
  await ensureVoiceChannel(client);
  await ensureHubOrder(client).catch(e => log('hub order:', e.message));
  refreshAcademyDashboard(client, { force: true }).catch(() => {});
  await syncCourseCards(client);
  await syncLibrary(client).catch(e => log('library sync:', e.message));
    // mods PDF upload channel + its pinned instructions
    await ensureUploadChannel(client).catch(e => log('uploads:', e.message));
    await postUploadInstructions(client).catch(e => log('uploads:', e.message));
    // backfill: every enrolled member gets their private progress channel
    markAllMembersDirty();
    await refreshMemberDashboards(client, { force: true }).catch(e => log('member dashboards:', e.message));
  });

  client.on('interactionCreate', async (i) => {
    try {
      if (i.isChatInputCommand()) await handleCommand(i);
      else if (i.isMessageContextMenuCommand()) await handleContextMenu(i);
      else if (i.isButton()) await handleButton(i);
      else if (i.isModalSubmit()) await handleModal(i);
      else if (i.isStringSelectMenu()) await handleSelect(i);
    } catch (e) {
      console.error('[coach] interaction error:', e);
      const msg = { content: `⚠️ ${e.message ?? 'Something went wrong.'}`, ephemeral: true };
      if (i.deferred || i.replied) await i.editReply(msg).catch(() => null);
      else await i.reply(msg).catch(() => null);
    }
  });

  client.on('messageCreate', async (msg) => {
    try { await onUploadMessage(client, msg); } catch (e) { reportError('uploads', e); }
  });
  if (msgIntent) log('PDF auto-detect in the uploads channel is ON');

  client.on('voiceStateUpdate', async (oldS, newS) => {
    const vcId = getSetting('study_vc');
    if (!vcId) return;
    const joined = newS.channelId === vcId && oldS.channelId !== vcId;
    const left = oldS.channelId === vcId && newS.channelId !== vcId;
    if (!joined && !left) return;
    const s = activeLiveSession();
    if (!s) return;
    const userId = newS.id;
    if (userId === client.user.id) return;
      if (joined) {
        const isNew = !A.getParticipant(userId);
        A.upsertParticipant(userId, newS.member?.displayName ?? newS.member?.user?.username ?? '');
        A.recordJoin(s.id, userId);
        log(`attendance: ${userId} joined session ${s.id}`);
        if (isNew) {
          markMemberDirty(userId); // first-timer: create their private progress channel
          const lesson = A.currentLesson();
          await bus.dm(userId, { content: lesson ? `Welcome to the academy, ${newS.member?.displayName ?? 'friend'}! 🎓 Current lesson: **${lesson.title}**` : 'Welcome to the academy! 🎓' });
        }
      } else {
      A.recordLeave(s.id, userId);
      log(`attendance: ${userId} left session ${s.id}`);
    }
  });
}

startWeb({ client, bus });
if (client) await client.login(config.coachToken);
await tick({ client, bus }).catch(e => log('initial tick:', e.message)); // catch-up on boot
setInterval(() => tick({ client, bus }).catch(e => log('tick:', e.message)), 20000);
startEngines({ client, bus });
log(`started (discord: ${config.disableDiscord ? 'DISABLED (dry-run)' : 'on'}, tz: ${config.tz})`);
