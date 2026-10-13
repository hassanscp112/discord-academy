// Slash commands + button routing for the Coach.
import {
  SlashCommandBuilder, ContextMenuCommandBuilder, ApplicationCommandType, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ChannelType, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle, AttachmentBuilder,
} from 'discord.js';
import { postBookPdf, fetchBookPdf, deletePdfThread } from './pdflib.js';
import { publishFromMessage, pdfAttachmentOf } from './uploads.js';
import * as A from '../core/academy.js';
import { getSetting, setSetting } from '../core/db.js';
import { zonedToUtc, fmtInTz } from '../core/time.js';
import { config } from '../core/config.js';
import { templates } from '../core/templates.js';
import { finishSession, proposeSlot } from './sessions.js';
import { markMemberDirty, memberDashPayload } from './memberdash.js';
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
  new SlashCommandBuilder().setName('quest').setDescription('Show the academy checklist')
    .addSubcommand(sc => sc.setName('list').setDescription('List checklist items')),
  new SlashCommandBuilder().setName('books').setDescription('📚 كتبي — تقدم القراءة'),
  new SlashCommandBuilder().setName('group').setDescription('📚 مجموعات القراءة')
    .addSubcommand(sc => sc.setName('list').setDescription('المجموعات النشطة'))
    .addSubcommand(sc => sc.setName('join').setDescription('انضم لمجموعة')
      .addIntegerOption(o => o.setName('id').setDescription('رقم المجموعة').setRequired(true)))
    .addSubcommand(sc => sc.setName('page').setDescription('سجّل صفحتك في كتاب المجموعة')
      .addIntegerOption(o => o.setName('id').setDescription('رقم المجموعة').setRequired(true))
      .addIntegerOption(o => o.setName('page').setDescription('الصفحة التي وصلت إليها').setRequired(true)))
    .addSubcommand(sc => sc.setName('leave').setDescription('خرج من مجموعة')
      .addIntegerOption(o => o.setName('id').setDescription('رقم المجموعة').setRequired(true))),
  new SlashCommandBuilder().setName('pdf').setDescription('📚 مكتبة PDF — نشر في فورم المكتبة (إدارة)')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addSubcommand(sc => sc.setName('add').setDescription('أنزل PDF كتاب كمنشور في فورم المكتبة')
      .addStringOption(o => o.setName('book').setDescription('عنوان الكتاب (موجود أو جديد)').setRequired(true))
      .addAttachmentOption(o => o.setName('file').setDescription('ملف الـPDF').setRequired(true))
      .addStringOption(o => o.setName('genre').setDescription('التصنيف (تاغ الفورم): عقيدة، فقه، حديث…'))
      .addIntegerOption(o => o.setName('pages').setDescription('عدد الصفحات (إن كان كتاباً جديداً)')))
    .addSubcommand(sc => sc.setName('remove').setDescription('فك ربط PDF عن كتاب وحذف منشوره')
      .addStringOption(o => o.setName('book').setDescription('عنوان الكتاب').setRequired(true))),
  new SlashCommandBuilder().setName('optout').setDescription('Toggle check-in DMs on/off for you'),
  new ContextMenuCommandBuilder().setName('📚 نشر في المكتبة').setType(ApplicationCommandType.Message),
];

const e = (title, desc, color = 0x5865f2) => new EmbedBuilder().setTitle(title).setDescription(desc.slice(0, 4000)).setColor(color);
const QCAT = { book: '📖', lecture: '📺', course: '🎓' };

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
    markMemberDirty(u.id); // ensures their private channel exists and is fresh
    const xp = A.xpTotal(u.id);
    const lvl = A.levelFor(xp);
    const done = A.listProgress(u.id);
    const total = A.listLessons().length;
    const streak = A.currentStreak(u.id);
    const quests = A.listQuests().map(q =>
      `${QCAT[q.category] ?? '📜'} ${q.title}${A.questCompletedBy(q.id, u.id) ? ' — ✅' : ''}`);
    const courses = A.listCourses().map(c => {
      const cp = A.courseProgress(c.id, u.id);
      return `📖 **${c.title}** — ${cp.done}/${cp.total}${cp.next ? ` · next: ${cp.next.title}` : ' · كملها كاملة 🎉'}`;
    });
    return interaction.reply({
      embeds: [e(`📈 ${u.username}`, [
        `**${xp} XP** · ${lvl.emoji} **${lvl.name}** · 🔥 streak: **${streak}**`,
        courses.length ? `\n${courses.join('\n')}` : `Lessons: **${done.length}/${total}**`,
        quests.length ? `\n**Checklist:**\n${quests.join('\n')}` : '',
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
    if (opts.getSubcommand() === 'list') {
      const rows = A.listQuests().map(q =>
        `${QCAT[q.category] ?? '📜'} **${q.title}** — ✅ ${A.questCompletionCount(q.id)}`);
      return interaction.reply({ embeds: [e('📜 Checklist', rows.join('\n') || '_Empty — the owner adds items from the dashboard._')] });
    }
  }

  if (cmd === 'books') {
    const shelf = A.bookShelf(interaction.user.id);
    const reading = shelf.filter(b => b.page > 0 || b.finished);
    const shown = reading.length ? reading : shelf.slice(0, 5);
    const lines = shown.map(b =>
      b.finished ? `✅ **${b.title}** — أكملته 🎉`
      : b.page > 0 ? `📖 **${b.title}** — صفحة **${b.page}**/${b.total_pages}`
      : `▫️ **${b.title}** — لم تبدأه بعد`);
    return interaction.reply({
      embeds: [e('📚 كتبي', lines.join('\n') || 'لا كتب في الأكاديمية بعد — اسأل عن مجموعات القراءة!')],
      ephemeral: true,
    });
  }

  if (cmd === 'group') {
    const sub = opts.getSubcommand();
    if (sub === 'list') {
      const groups = A.listGroups();
      if (!groups.length) return interaction.reply({ embeds: [e('📚 مجموعات القراءة', 'لا مجموعات نشطة الآن.')], ephemeral: true });
      const lines = groups.map(g => `#${g.id} · **${g.title}** — كتاب: **${g.book_title}** (${g.total_pages} صفحة)`);
      return interaction.reply({ embeds: [e('📚 مجموعات القراءة', lines.join('\n'))], ephemeral: true });
    }
    const gid = opts.getInteger('id', true);
    const g = A.getGroup(gid);
    if (!g || g.status !== 'active') return interaction.reply({ content: 'لا توجد مجموعة نشطة بهذا الرقم.', ephemeral: true });
    if (sub === 'join') {
      A.joinGroup(gid, interaction.user.id, interaction.member?.displayName ?? interaction.user.username);
      markMemberDirty(interaction.user.id);
      return interaction.reply({ content: `✅ انضممت إلى **${g.title}**! حدّث صفحتك بزر «📝 سجّل صفحتك» أو بـ \`/group page ${gid} <الصفحة>\`.`, ephemeral: true });
    }
    if (sub === 'page') {
      const r = A.setBookProgress(interaction.user.id, g.book_id, opts.getInteger('page', true));
      A.joinGroup(gid, interaction.user.id, interaction.member?.displayName ?? interaction.user.username);
      markMemberDirty(interaction.user.id);
      return interaction.reply({ content: r.finished ? `🎉 أكملت **${g.book_title}** كاملاً!` : `📖 سُجّل: صفحة **${r.page}** من ${g.total_pages} في **${g.book_title}**.`, ephemeral: true });
    }
    if (sub === 'leave') {
      A.leaveGroup(gid, interaction.user.id);
      return interaction.reply({ content: `خرجت من **${g.title}**.`, ephemeral: true });
    }
  }

  if (cmd === 'pdf') {
    if (!isAdmin(interaction)) return interaction.reply({ content: 'للإدارة فقط.', ephemeral: true });
    const sub = opts.getSubcommand();
    if (sub === 'add') {
      await interaction.deferReply({ ephemeral: true });
      const file = opts.getAttachment('file', true);
      const genre = opts.getString('genre');
      let book = A.findBookByTitle(opts.getString('book', true));
      const isNew = !book;
      if (isNew) book = A.getBook(A.addBook({ title: opts.getString('book', true), totalPages: opts.getInteger('pages') ?? 200 }));
      try {
        const buf = Buffer.from(await (await fetch(file.url)).arrayBuffer());
        const r = await postBookPdf(interaction.client, book, buf, file.name, genre);
        A.setBookPdf(book.id, { msgId: r.threadId, name: r.name, size: r.size, genre });
        if (isNew) {
          const { publishBook } = await import('./library.js');
          await publishBook(interaction.client, A.getBook(book.id));
        }
        return interaction.editReply(`📄 نُشر **${book.title}** في فورم المكتبة${genre ? ` تحت «${genre}»` : ''} — والتحميل متاح للأعضاء من لوحاتهم ✓`);
      } catch (e) { return interaction.editReply(`❌ ${e.message}`); }
    }
    if (sub === 'remove') {
      const book = A.findBookByTitle(opts.getString('book', true));
      if (!book?.pdf_msg_id) return interaction.reply({ content: 'لم أجد كتاباً بهذا العنوان وبملف PDF.', ephemeral: true });
      await deletePdfThread(interaction.client, book);
      A.clearBookPdf(book.id);
      return interaction.reply({ content: `فُكّ ربط الملف عن **${book.title}** وحُذف منشوره من الفورم.`, ephemeral: true });
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
    if (!res.already) markMemberDirty(interaction.user.id);
    if (res.already) return interaction.reply({ content: 'You already marked this lesson ✅', ephemeral: true });
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

  if (kind === 'quest') {
    if (action === 'check') {
      A.upsertParticipant(interaction.user.id, interaction.user.username);
      const done = A.checkQuest(parseInt(idStr, 10), interaction.user.id);
      markMemberDirty(interaction.user.id);
      if (!done) return interaction.reply({ content: 'هذا العنصر لم يعد في القائمة.', ephemeral: true });
      if (!done.first) return interaction.reply({ content: 'سجّلته من قبل ✅', ephemeral: true });
      await interaction.channel?.send(templates.quest_done
        .replace('{{mention}}', `<@${interaction.user.id}>`)
        .replace('{{title}}', done.quest.title)).catch(() => null);
      markDashboardDirty();
      await refreshDashboard(interaction.client, { force: true }).catch(() => null);
      return interaction.reply({ content: `سُجّل إنجازك ✅ — **${done.quest.title}**`, ephemeral: true });
    }
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
      const slots = [proposeSlot(after, session), ...[1, 2].map(d => new Date(after.getTime() + d * 86400000))];
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

  if (kind === 'grp') {
    const gid = parseInt(idStr, 10);
    const g = A.getGroup(gid);
    if (!g || g.status !== 'active') return interaction.reply({ content: 'هذه المجموعة لم تعد نشطة.', ephemeral: true });
    if (action === 'join') {
      A.joinGroup(gid, interaction.user.id, interaction.member?.displayName ?? interaction.user.username);
      markMemberDirty(interaction.user.id);
      return interaction.reply({ content: `✅ انضممت إلى **${g.title}**! حدّث صفحتك من زر «📝 سجّل صفحتك» في رسالة المجموعة.`, ephemeral: true });
    }
    if (action === 'page') {
      const modal = new ModalBuilder()
        .setCustomId(`grp:modal:${gid}`)
        .setTitle(`تقدمك في: ${g.book_title}`.slice(0, 45));
      modal.addComponents(new ActionRowBuilder().addComponents(
        new TextInputBuilder().setCustomId('page').setLabel('وصلت إلى صفحة…').setStyle(TextInputStyle.Short).setRequired(true),
      ));
      return interaction.showModal(modal);
    }
  }

  // member dashboard tabs + actions (in the private progress channels)
  // NOTE: mview/mcomplete/bkpage customIds are TWO-segment — the id lives in `action`
  if (kind === 'mview') {
    await interaction.deferUpdate(); // card rendering may take a moment
    const view = await memberDashPayload(interaction.user.id, action);
    if (!view) return interaction.editReply({ content: 'صفحة غير معروفة.' });
    return interaction.editReply(view);
  }
  if (kind === 'mcomplete') {
    const cp = A.courseProgress(parseInt(action, 10), interaction.user.id);
    if (!cp.next) return interaction.reply({ content: 'أكملت كل دروس هذه الدورة 🎉', ephemeral: true });
    const res = A.completeLesson(interaction.user.id, cp.next.lesson_id);
    markMemberDirty(interaction.user.id);
    if (!res.already) await announceLevelUp(interaction.client, interaction.user.id, res.total - (res.granted ?? 0));
    await interaction.deferUpdate();
    await interaction.editReply(await memberDashPayload(interaction.user.id, 'courses'));
    return interaction.followUp({
      content: res.already ? 'هذا الدرس مسجل من قبل ✅' : `✅ سُجّل إنجاز **${cp.next.title}** (+${res.granted} XP)`,
      ephemeral: true,
    });
  }
  if (kind === 'bkpage') {
    const book = A.getBook(parseInt(action, 10));
    if (!book) return interaction.reply({ content: 'الكتاب غير موجود.', ephemeral: true });
    const modal = new ModalBuilder()
      .setCustomId(`bk:modal:${book.id}`)
      .setTitle(`تقدمك في: ${book.title}`.slice(0, 45));
    modal.addComponents(new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('page').setLabel('وصلت إلى صفحة…').setStyle(TextInputStyle.Short).setRequired(true),
    ));
    return interaction.showModal(modal);
  }

  // أزرار التسجيل بالدورات (قناة 🔔-التسجيل-بالدورات)
  if (kind === 'csub' || kind === 'cunsub') {
    return handleSubscribe(interaction, action, kind === 'csub');
  }

  // per-course notification opt-in (member dashboard «الإشعارات» tab)
  if (kind === 'sub') {
    const course = A.getCourse(parseInt(action, 10));
    if (!course) return interaction.reply({ content: 'الدورة غير موجودة.', ephemeral: true });
    const on = A.toggleCourseSub(course.id, interaction.user.id, interaction.member?.displayName ?? interaction.user.username);
    if (course.role_id && interaction.member?.roles) {
      try { on ? await interaction.member.roles.add(course.role_id) : await interaction.member.roles.remove(course.role_id); } catch {}
    }
    await interaction.deferUpdate();
    await interaction.editReply(await memberDashPayload(interaction.user.id, 'subs'));
    return interaction.followUp({
      content: on ? `🔔 ستُشعَر بحصص **${course.title}**.` : `🔕 أوقفت إشعار **${course.title}**.`,
      ephemeral: true,
    });
  }

  // quiz answers (questions posted after class)
  if (kind === 'quiz') {
    const r = A.answerQuestion(interaction.user.id, parseInt(action, 10), parseInt(idStr, 10));
    if (!r) return interaction.reply({ content: 'هذا السؤال لم يعد متاحاً.', ephemeral: true });
    if (r.already) return interaction.reply({ content: 'أجبت على هذا السؤال من قبل 🙂', ephemeral: true });
    if (r.correct) {
      const before = A.xpTotal(interaction.user.id);
      A.awardXp(interaction.user.id, r.question.xp, 'quiz');
      markMemberDirty(interaction.user.id);
      await announceLevelUp(interaction.client, interaction.user.id, before);
      return interaction.reply({ content: `✅ إجابة صحيحة! +${r.question.xp} نقطة`, ephemeral: true });
    }
    return interaction.reply({ content: '❌ ليست الإجابة الصحيحة — راجع الدرس وحاول التركيز في الحصة القادمة!', ephemeral: true });
  }

  // mods upload flow: panel button -> modal (pdfup:btn:<sourceMsgId>)
  if (kind === 'pdfup' && action === 'btn') {
    if (!isAdmin(interaction)) return interaction.reply({ content: 'للإدارة فقط.', ephemeral: true });
    const src = await interaction.channel?.messages?.fetch(idStr).catch(() => null);
    const att = pdfAttachmentOf(src);
    if (!att) return interaction.reply({ content: 'لم أجد الملف الأصلي — أعد رفعه.', ephemeral: true });
    return openUploadModal(interaction, idStr, att.name);
  }

  // onboarding guide button — points the member at their private board
  if (kind === 'onboard') {
    const p = A.getParticipant(interaction.user.id);
    if (p?.private_channel_id) {
      return interaction.reply({ content: `📊 لوحتك هنا: <#${p.private_channel_id}> — تفضل!`, ephemeral: true });
    }
    return interaction.reply({
      content: '🎧 لوحتك الخاصة تُنشأ تلقائياً من أول حضور لحصة أو أول إنجاز — نراك في الحصة القادمة!',
      ephemeral: true,
    });
  }

  if (kind === 'mnoop') return interaction.deferUpdate();

  return interaction.reply({ content: 'Unknown button.', ephemeral: true });
}

// right-click a message with a PDF -> publish flow (same modal as the upload channel)
export async function handleContextMenu(interaction) {
  if (interaction.commandName !== '📚 نشر في المكتبة') {
    return interaction.reply({ content: 'Unknown command.', ephemeral: true });
  }
  if (!isAdmin(interaction)) return interaction.reply({ content: 'للإدارة فقط.', ephemeral: true });
  const att = pdfAttachmentOf(interaction.targetMessage);
  if (!att) return interaction.reply({ content: 'لا يوجد ملف PDF في هذه الرسالة.', ephemeral: true });
  await openUploadModal(interaction, interaction.targetMessage.id, att.name);
}

// the title/pages/category form shared by both entry points
async function openUploadModal(interaction, sourceMsgId, fileName) {
  const baseName = fileName.replace(/\.pdf$/i, '').replace(/[_-]+/g, ' ').trim();
  const modal = new ModalBuilder()
    .setCustomId(`pdfup:modal:${sourceMsgId}`)
    .setTitle('نشر الكتاب في المكتبة'.slice(0, 45));
  modal.addComponents(
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('title').setLabel('عنوان الكتاب')
        .setStyle(TextInputStyle.Short).setRequired(true).setValue(baseName.slice(0, 100))),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('pages').setLabel('عدد الصفحات')
        .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('مثال: 640')),
    new ActionRowBuilder().addComponents(
      new TextInputBuilder().setCustomId('genre').setLabel('التصنيف (تاغ الفورم)')
        .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('عقيدة / فقه / حديث…')),
  );
  return interaction.showModal(modal);
}

// select menus — the PDF download menu in member channels
export async function handleSelect(interaction) {
  const kind = interaction.customId.split(':')[0];
  if (kind === 'pdfget') {
    const book = A.getBook(Number(interaction.values?.[0]));
    if (!book?.pdf_msg_id) return interaction.reply({ content: 'هذا الكتاب بلا ملف PDF.', ephemeral: true });
    await interaction.deferReply();
    const pdf = await fetchBookPdf(interaction.client, book);
    if (!pdf) return interaction.editReply('تعذّر جلب الملف — ربما حُذف منشوره من الفورم. أخبر الإدارة.');
    return interaction.editReply({
      content: `📖 **${book.title}** — تفضل ملفك:`,
      files: [new AttachmentBuilder(pdf.buffer, { name: pdf.name })],
    });
  }
  return interaction.reply({ content: 'Unknown menu.', ephemeral: true });
}

// modal submits — reading-group + personal book page inputs live here
export async function handleModal(interaction) {
  const [kind, , idStr] = interaction.customId.split(':');
  if (kind === 'grp') {
    const gid = parseInt(idStr, 10);
    const g = A.getGroup(gid);
    if (!g || g.status !== 'active') return interaction.reply({ content: 'هذه المجموعة لم تعد نشطة.', ephemeral: true });
    const page = parseInt(interaction.fields.getTextInputValue('page'), 10);
    if (!Number.isFinite(page) || page < 0) return interaction.reply({ content: 'أدخل رقم صفحة صالحاً.', ephemeral: true });
    const r = A.setBookProgress(interaction.user.id, g.book_id, page);
    A.joinGroup(gid, interaction.user.id, interaction.member?.displayName ?? interaction.user.username);
    markMemberDirty(interaction.user.id);
    return interaction.reply({
      content: r.finished ? `🎉 أكملت **${g.book_title}** كاملاً!` : `📖 سُجّل: صفحة **${r.page}** من ${g.total_pages} في **${g.book_title}**.`,
      ephemeral: true,
    });
  }
  if (kind === 'bk') {
    const book = A.getBook(parseInt(idStr, 10));
    if (!book) return interaction.reply({ content: 'الكتاب غير موجود.', ephemeral: true });
    const page = parseInt(interaction.fields.getTextInputValue('page'), 10);
    if (!Number.isFinite(page) || page < 0) return interaction.reply({ content: 'أدخل رقم صفحة صالحاً.', ephemeral: true });
    const r = A.setBookProgress(interaction.user.id, book.id, page);
    markMemberDirty(interaction.user.id);
    return interaction.reply({
      content: r.finished ? `🎉 أكملت **${book.title}** كاملاً!` : `📖 سُجّل: صفحة **${r.page}** من ${book.total_pages} في **${book.title}**.`,
      ephemeral: true,
    });
  }
  if (kind === 'pdfup') {
    // pdfup:modal:<sourceMsgId> — publish the book from the original message
    if (!isAdmin(interaction)) return interaction.reply({ content: 'للإدارة فقط.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const src = await interaction.channel?.messages?.fetch(idStr).catch(() => null);
    if (!src) return interaction.editReply('لم أجد الرسالة الأصلية.');
    const title = interaction.fields.getTextInputValue('title')?.trim();
    const pages = parseInt(interaction.fields.getTextInputValue('pages'), 10);
    const genre = interaction.fields.getTextInputValue('genre')?.trim();
    if (!title || !Number.isFinite(pages) || pages <= 0) return interaction.editReply('أكمل العنوان وعدد صفحات صحيحاً.');
    try {
      const r = await publishFromMessage(interaction.client, { message: src, title, pages, genre });
      return interaction.editReply(`✅ نُشر **${r.book.title}**${genre ? ` تحت «${genre}»` : ''} في فورم المكتبة${r.isNew ? ' وأُضيف للمكتبة' : ''} — متاح للتحميل من لوحات الأعضاء.`);
    } catch (e) { return interaction.editReply(`❌ ${e.message}`); }
  }
  return interaction.reply({ content: 'Unknown form.', ephemeral: true });
}
