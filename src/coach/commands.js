// Slash commands + button routing for the Coach.
import {
  SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, PermissionFlagsBits,
} from 'discord.js';
import * as A from '../core/academy.js';
import { getSetting, setSetting } from '../core/db.js';
import { zonedToUtc, fmtInTz } from '../core/time.js';
import { config } from '../core/config.js';
import { templates } from '../core/templates.js';
import { finishSession, proposeSlot } from './sessions.js';
import { stopStream } from './streamer.js';
import { announceLevelUp } from './gamification.js';
import { refreshDashboard, markDashboardDirty } from './dashboard.js';

export const commandDefs = [
  new SlashCommandBuilder().setName('lesson').setDescription('Manage course lessons (admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sc => sc.setName('add').setDescription('Add a lesson')
      .addStringOption(o => o.setName('title').setDescription('Lesson title').setRequired(true))
      .addStringOption(o => o.setName('url').setDescription('YouTube URL'))
      .addIntegerOption(o => o.setName('duration').setDescription('Duration in minutes (default 60)')))
    .addSubcommand(sc => sc.setName('list').setDescription('List lessons'))
    .addSubcommand(sc => sc.setName('remove').setDescription('Remove a lesson')
      .addIntegerOption(o => o.setName('id').setDescription('Lesson id (see /lesson list)').setRequired(true))),
  new SlashCommandBuilder().setName('schedule').setDescription('Manage the class schedule (admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sc => sc.setName('template').setDescription('Weekly repeating slot, e.g. Sun+Wed 20:00')
      .addStringOption(o => o.setName('days').setDescription('Comma-separated: sun,wed').setRequired(true))
      .addStringOption(o => o.setName('time').setDescription('HH:mm, e.g. 20:00').setRequired(true)))
    .addSubcommand(sc => sc.setName('generate').setDescription('Fill the next template slots with upcoming lessons'))
    .addSubcommand(sc => sc.setName('list').setDescription('Show scheduled sessions'))
    .addSubcommand(sc => sc.setName('move').setDescription('Move a session to a new date/time')
      .addIntegerOption(o => o.setName('id').setDescription('Session id (see /schedule list)').setRequired(true))
      .addStringOption(o => o.setName('date').setDescription('YYYY-MM-DD').setRequired(true))
      .addStringOption(o => o.setName('time').setDescription('HH:mm').setRequired(true)))
    .addSubcommand(sc => sc.setName('cancel').setDescription('Cancel a session')
      .addIntegerOption(o => o.setName('id').setDescription('Session id').setRequired(true))),
  new SlashCommandBuilder().setName('setup').setDescription('Configure channels for the academy (admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o => o.setName('dashboard').setDescription('Channel for the dashboard embed + announcements').addChannelTypes(ChannelType.GuildText))
    .addChannelOption(o => o.setName('study_vc').setDescription('The voice channel where classes happen').addChannelTypes(ChannelType.GuildVoice))
    .addRoleOption(o => o.setName('ping_role').setDescription('Role to ping for session reminders')),
  new SlashCommandBuilder().setName('myprogress').setDescription('Show your progress'),
  new SlashCommandBuilder().setName('leaderboard').setDescription('XP leaderboard')
    .addBooleanOption(o => o.setName('full').setDescription('Include inactive members (admin view)')),
  new SlashCommandBuilder().setName('quest').setDescription('Manage quests (admin)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sc => sc.setName('create').setDescription('Create a quest')
      .addStringOption(o => o.setName('title').setDescription('Quest title').setRequired(true))
      .addStringOption(o => o.setName('lessons').setDescription('Comma-separated lesson ids').setRequired(true))
      .addStringOption(o => o.setName('ends').setDescription('End date YYYY-MM-DD').setRequired(true)))
    .addSubcommand(sc => sc.setName('list').setDescription('List quests'))
    .addSubcommand(sc => sc.setName('end').setDescription('End a quest now')
      .addIntegerOption(o => o.setName('id').setDescription('Quest id').setRequired(true))),
  new SlashCommandBuilder().setName('optout').setDescription('Toggle check-in DMs on/off for you'),
];

const e = (title, desc, color = 0x5865f2) => new EmbedBuilder().setTitle(title).setDescription(desc.slice(0, 4000)).setColor(color);

export function isAdmin(interaction) {
  return interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild) || config.bossIds.includes(interaction.user.id);
}

export async function handleCommand(interaction) {
  const cmd = interaction.commandName;
  const opts = interaction.options;
  const tz = config.tz;

  if (cmd === 'lesson') {
    const sub = opts.getSubcommand();
    if (sub === 'add') {
      const id = A.addLesson({
        title: opts.getString('title', true),
        url: opts.getString('url') ?? '',
        durationMin: opts.getInteger('duration') ?? 60,
      });
      markDashboardDirty();
      return interaction.reply({ embeds: [e('✅ Lesson added', `#${id} — **${opts.getString('title')}**\nPosition: ${A.getLesson(id).position}`)] });
    }
    if (sub === 'list') {
      const rows = A.listLessons().map(l => {
        const s = A.sessionForLesson(l.id);
        return `#${l.id} · **${l.title}** · ${l.status}${s ? ` · 🗓️ ${fmtInTz(new Date(s.scheduled_at), tz)}` : ''}`;
      });
      return interaction.reply({ embeds: [e('📚 Lessons', rows.length ? rows.join('\n') : '_None yet — add one with /lesson add_')] });
    }
    if (sub === 'remove') {
      const ok = A.removeLesson(opts.getInteger('id', true));
      markDashboardDirty();
      return interaction.reply({ embeds: [e(ok ? '🗑️ Removed' : '❌ Not found', ok ? 'Lesson and its sessions were removed.' : 'No lesson with that id.', ok ? 0x57f287 : 0xed4245)] });
    }
  }

  if (cmd === 'schedule') {
    const sub = opts.getSubcommand();
    if (sub === 'template') {
      const map = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
      const days = opts.getString('days', true).toLowerCase().split(',').map(d => map[d.trim()]).filter(d => d !== undefined);
      if (!days.length) return interaction.reply({ embeds: [e('❌ Bad days', 'Use day names like `sun,wed`')] });
      const time = opts.getString('time', true);
      if (!/^\d{2}:\d{2}$/.test(time)) return interaction.reply({ embeds: [e('❌ Bad time', 'Use `HH:mm`, e.g. `20:00`')] });
      A.setTemplate({ days, time });
      markDashboardDirty();
      return interaction.reply({ embeds: [e('✅ Weekly template set', `Every week on **${days.map(d => ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d]).join(' & ')}** at **${time}** (${tz}).\nNow run \`/schedule generate\`.`)] });
    }
    if (sub === 'generate') {
      try {
        const created = A.generateSchedule({});
        if (!created.length) return interaction.reply({ embeds: [e('📅 Nothing to schedule', 'All planned lessons already have a session.')] });
        // auto quest for the week's lessons
        const lessonIds = [...new Set(created.map(s => s.lesson_id))];
        const titles = lessonIds.map(id => A.getLesson(id)?.title).filter(Boolean);
        const last = created[created.length - 1];
        A.createQuest({
          title: `Keep pace: ${titles.join(' + ')}`,
          description: "Finish the lessons of this week's live sessions!",
          lessonIds,
          startsAt: new Date().toISOString(),
          endsAt: new Date(new Date(last.scheduled_at).getTime() + 86400000).toISOString(),
          auto: true,
        });
        markDashboardDirty();
        await refreshDashboard(interaction.client, { force: true });
        const lines = created.map(s => `**${A.getLesson(s.lesson_id).title}** → ${fmtInTz(new Date(s.scheduled_at), tz)}`);
        return interaction.reply({ embeds: [e('📅 Sessions scheduled', lines.join('\n'))] });
      } catch (err) {
        return interaction.reply({ embeds: [e('❌ Could not schedule', err.message, 0xed4245)], ephemeral: true });
      }
    }
    if (sub === 'list') {
      const rows = A.listSessions({ future: true, limit: 20 }).map(s => {
        const l = A.getLesson(s.lesson_id);
        return `#${s.id} · **${l?.title ?? '?'}** · ${fmtInTz(new Date(s.scheduled_at), tz)} · ${s.status}`;
      });
      return interaction.reply({ embeds: [e('🗓️ Upcoming sessions', rows.length ? rows.join('\n') : '_None — use /schedule template + generate_')] });
    }
    if (sub === 'move') {
      const id = opts.getInteger('id', true);
      const date = opts.getString('date', true), time = opts.getString('time', true);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
        return interaction.reply({ embeds: [e('❌ Bad format', 'date = `YYYY-MM-DD`, time = `HH:mm`', 0xed4245)], ephemeral: true });
      }
      const when = zonedToUtc(date, time, tz);
      A.setSession(id, when.toISOString());
      markDashboardDirty();
      await refreshDashboard(interaction.client, { force: true });
      return interaction.reply({ embeds: [e('📆 Session moved', `#${id} → **${fmtInTz(when, tz)}**`)] });
    }
    if (sub === 'cancel') {
      A.cancelSession(opts.getInteger('id', true));
      markDashboardDirty();
      return interaction.reply({ embeds: [e('🚫 Session cancelled', `#${opts.getInteger('id')} — the lesson stays in the course.`)] });
    }
  }

  if (cmd === 'setup') {
    if (opts.getChannel('dashboard')) setSetting('channel_dashboard', opts.getChannel('dashboard').id);
    if (opts.getChannel('study_vc')) setSetting('study_vc', opts.getChannel('study_vc').id);
    if (opts.getRole('ping_role')) setSetting('ping_role', opts.getRole('ping_role').id);
    return interaction.reply({
      embeds: [e('⚙️ Setup saved', [
        `Dashboard channel: <#${getSetting('channel_dashboard')}>`,
        `Study VC: ${getSetting('study_vc') ? `<#${getSetting('study_vc')}>` : '_not set_'}`,
        `Ping role: ${getSetting('ping_role') ? `<@&${getSetting('ping_role')}>` : '_not set_'}`,
      ].join('\n'))], ephemeral: true,
    });
  }

  if (cmd === 'myprogress') {
    const u = interaction.user;
    A.upsertParticipant(u.id, u.username);
    const xp = A.xpTotal(u.id);
    const lvl = A.levelFor(xp);
    const done = A.listProgress(u.id);
    const total = A.listLessons().length;
    const streak = A.currentStreak(u.id);
    const quests = A.listQuests().map(q => {
      const need = q.lesson_ids.length;
      const have = q.lesson_ids.filter(id => done.some(d => d.lesson_id === id)).length;
      return `🗝️ ${q.title} — ${have}/${need}${A.questCompletedBy(q.id, u.id) ? ' ✅' : ''}`;
    });
    return interaction.reply({
      embeds: [e(`📈 ${u.username}`, [
        `**${xp} XP** · ${lvl.emoji} **${lvl.name}** · 🔥 streak: **${streak}**`,
        `Lessons: **${done.length}/${total}**`,
        quests.length ? `\n${quests.join('\n')}` : '',
      ].join('\n'))], ephemeral: true,
    });
  }

  if (cmd === 'leaderboard') {
    const full = opts.getBoolean('full') && isAdmin(interaction);
    const rows = A.xpLeaderboard(15);
    if (!rows.length) return interaction.reply({ embeds: [e('🏆 Leaderboard', '_No XP yet — come to a session!_')] });
    const lines = rows.map((r, i) => {
      const p = A.getParticipant(r.user_id);
      const lvl = A.levelFor(r.xp);
      return `${['🥇','🥈','🥉'][i] ?? '▫️'} **${p?.display_name || r.user_id}** — ${r.xp} XP · ${lvl.emoji} ${lvl.name} · 🔥 ${A.currentStreak(r.user_id)}`;
    });
    const extra = full ? '\n\n_Inactive this week:_' + (A.weeklyRecap().falling.map(f => `\n💤 ${f.display_name || f.user_id}`).join('') || ' none!') : '';
    return interaction.reply({ embeds: [e('🏆 Leaderboard', lines.join('\n') + extra)] });
  }

  if (cmd === 'quest') {
    const sub = opts.getSubcommand();
    if (sub === 'create') {
      const ids = opts.getString('lessons', true).split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
      const ends = opts.getString('ends', true);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(ends)) return interaction.reply({ embeds: [e('❌ Bad date', 'Use `YYYY-MM-DD`', 0xed4245)], ephemeral: true });
      const id = A.createQuest({
        title: opts.getString('title', true),
        lessonIds: ids,
        startsAt: new Date().toISOString(),
        endsAt: zonedToUtc(ends, '23:59', tz).toISOString(),
      });
      markDashboardDirty();
      await interaction.deferReply();
      const ch = getSetting('channel_dashboard');
      if (ch) {
        const c = await interaction.client.channels.fetch(ch).catch(() => null);
        if (c) await c.send({ content: templates.quest_new
          .replace('{{title}}', opts.getString('title', true))
          .replace('{{description}}', `Finish lessons ${ids.join(', ')}`)
          .replace('{{xp}}', String(getSetting('xp_quest', '150')))
          .replace('{{ends}}', ends) });
      }
      return interaction.editReply({ embeds: [e('🗝️ Quest created', `#${id} — ${opts.getString('title')}`)] });
    }
    if (sub === 'list') {
      const rows = A.listQuests({ activeOnly: false }).slice(0, 10).map(q => `#${q.id} · **${q.title}** · ends ${q.ends_at.slice(0, 10)} · ${q.status}`);
      return interaction.reply({ embeds: [e('🗝️ Quests', rows.join('\n') || '_None_')] });
    }
    if (sub === 'end') {
      A.endQuest(opts.getInteger('id', true));
      return interaction.reply({ embeds: [e('🏁 Quest ended', `#${opts.getInteger('id')}`)] });
    }
  }

  if (cmd === 'optout') {
    const p = A.getParticipant(interaction.user.id);
    const nowDisabled = p ? !p.dms_enabled : true; // not enrolled -> opting in? default: enable DMs
    const newState = A.optOut(interaction.user.id, nowDisabled);
    A.upsertParticipant(interaction.user.id, interaction.user.username);
    return interaction.reply({ content: newState ? '✅ Check-in DMs are **on**.' : '🔕 Check-in DMs are **off**.', ephemeral: true });
  }

  return interaction.reply({ content: 'Unknown command.', ephemeral: true });
}

export async function handleButton(interaction) {
  const [kind, action, idStr, slotIso] = interaction.customId.split(':');
  const boss = config.bossIds.includes(interaction.user.id);

  if (kind === 'complete') {
    const lessonId = parseInt(idStr, 10);
    A.upsertParticipant(interaction.user.id, interaction.user.username);
    const before = A.xpTotal(interaction.user.id);
    const res = A.completeLesson(interaction.user.id, lessonId);
    if (res.already) return interaction.reply({ content: 'You already marked this lesson ✅', ephemeral: true });
    for (const q of A.listQuests()) {
      const done = await A.tryCompleteQuest(q.id, interaction.user.id);
      if (done) {
        await interaction.channel?.send(templates.quest_done
          .replace('{{mention}}', `<@${interaction.user.id}>`)
          .replace('{{title}}', q.title).replace('{{xp}}', String(done.quest.xp_reward)));
      }
    }
    await announceLevelUp(interaction.client, interaction.user.id, before);
    const xp = A.xpTotal(interaction.user.id);
    const lvl = A.levelFor(xp);
    markDashboardDirty();
    await refreshDashboard(interaction.client, { force: true });
    return interaction.reply({
      content: `🎉 Recorded: **${res.granted} XP** — total **${xp} XP** (${lvl.emoji} ${lvl.name})`,
      ephemeral: true,
    });
  }

  if (kind === 'sess') {
    const id = parseInt(idStr, 10);
    const session = A.getSession(id);
    if (!session) return interaction.reply({ content: 'That session is gone.', ephemeral: true });
    const lesson = A.getLesson(session.lesson_id);

    if (action === 'move' && session.status === 'missed_poll' && session.proposed_at) {
      A.setSession(id, session.proposed_at);
      markDashboardDirty();
      await refreshDashboard(interaction.client, { force: true });
      return interaction.update({ content: `📆 Moved **${lesson.title}** to **${fmtInTz(new Date(session.proposed_at), config.tz)}** — see you there!`, components: [] });
    }
    if (action === 'slots' && session.status === 'missed_poll') {
      if (!boss) return interaction.reply({ content: 'Only the academy owner can pick a custom time.', ephemeral: true });
      const after = new Date(session.scheduled_at);
      const slots = [proposeSlot(after), ...[1, 2].map(d => new Date(after.getTime() + d * 86400000))];
      const row = new ActionRowBuilder().addComponents(slots.slice(0, 3).map(s =>
        new ButtonBuilder().setCustomId(`sess:set:${id}:${s.toISOString()}`).setLabel(fmtInTz(s, config.tz)).setStyle(ButtonStyle.Secondary)));
      return interaction.reply({ content: 'Pick a new time:', components: [row], ephemeral: true });
    }
    if (action === 'set') {
      if (!boss) return interaction.reply({ content: 'Only the academy owner can do that.', ephemeral: true });
      A.setSession(id, slotIso);
      markDashboardDirty();
      await refreshDashboard(interaction.client, { force: true });
      return interaction.update({ content: `📆 Moved **${lesson.title}** to **${fmtInTz(new Date(slotIso), config.tz)}**`, components: [] });
    }
    if (action === 'skip') {
      if (!boss) return interaction.reply({ content: 'Only the academy owner can do that.', ephemeral: true });
      A.cancelSession(id);
      stopStream();
      markDashboardDirty();
      return interaction.update({ content: `⏭️ Skipped **${lesson.title}** — it stays in the course list.`, components: [] });
    }
    if (action === 'finish') {
      if (!boss && !isAdmin(interaction)) return interaction.reply({ content: 'Only the academy owner can finish the session.', ephemeral: true });
      await interaction.deferReply();
      await finishSession({ client: interaction.client, bus: null, sessionId: id });
      return interaction.editReply({ content: '✅ Session finished — attendees got their XP.' });
    }
  }
  return interaction.reply({ content: 'Unknown button.', ephemeral: true });
}
