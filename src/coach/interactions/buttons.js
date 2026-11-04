// Every button. customId is split as [kind, action, idStr, slotIso] —
// TWO-segment ids (kind:id) carry the id in `action` (see docs/4 + docs/7).
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import * as A from '../../core/academy.js';
import { pdfAttachmentOf } from '../uploads.js';
import { fmtInTz } from '../../core/time.js';
import { config } from '../../core/config.js';
import { templates } from '../../core/templates.js';
import { finishSession, proposeSlot } from '../sessions.js';
import { markMemberDirty, memberDashPayload } from '../memberdash.js';
import { stopStream } from '../streamer.js';
import { createBus } from '../bus.js';
import { isAdmin, openUploadModal } from './shared.js';

export async function handleButton(interaction) {
  const [kind, action, idStr, slotIso] = interaction.customId.split(':');
  const boss = config.bossIds.includes(interaction.user.id);

  if (kind === 'complete') { // two-segment: complete:<lessonId>
    const lesson = A.getLesson(parseInt(action, 10));
    if (!lesson) return interaction.reply({ content: 'هذا الدرس لم يعد موجوداً.', ephemeral: true });
    A.upsertParticipant(interaction.user.id, interaction.user.username);
    const res = A.completeLesson(interaction.user.id, lesson.id);
    if (res.already) return interaction.reply({ content: 'هذا الدرس مسجل من قبل ✅', ephemeral: true });
    markMemberDirty(interaction.user.id);
    const done = { content: `🎉 سُجّل إنجاز **${lesson.title}** — بارك الله فيك!`, ephemeral: true };
    // on the member's own "you attended" card the button has served its purpose — remove it
    if (interaction.channelId && interaction.channelId === A.getParticipant(interaction.user.id)?.private_channel_id) {
      await interaction.update({ components: [] });
      return interaction.followUp(done);
    }
    return interaction.reply(done);
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
      return interaction.reply({ content: `سُجّل إنجازك ✅ — **${done.quest.title}**`, ephemeral: true });
    }
  }

  if (kind === 'sess') {
    const id = parseInt(idStr, 10);
    const session = A.getSession(id);
    if (!session) return interaction.reply({ content: 'هذه الحصة لم تعد موجودة.', ephemeral: true });
    const lesson = A.getLesson(session.lesson_id);

    if (action === 'move' && session.status === 'missed_poll' && session.proposed_at) {
      A.setSession(id, session.proposed_at);
      return interaction.update({ content: `📆 نُقل **${lesson.title}** إلى **${fmtInTz(new Date(session.proposed_at), config.tz)}** — نراكم هناك!`, components: [] });
    }
    if (action === 'slots' && session.status === 'missed_poll') {
      if (!boss) return interaction.reply({ content: 'اختيار موعد آخر لمشرف الأكاديمية فقط.', ephemeral: true });
      const after = new Date(session.scheduled_at);
      const slots = [proposeSlot(after, session), ...[1, 2].map(d => new Date(after.getTime() + d * 86400000))];
      const row = new ActionRowBuilder().addComponents(slots.slice(0, 3).map(s =>
        new ButtonBuilder().setCustomId(`sess:set:${id}:${s.toISOString()}`).setLabel(fmtInTz(s, config.tz)).setStyle(ButtonStyle.Secondary)));
      return interaction.reply({ content: 'اختر موعداً جديداً:', components: [row], ephemeral: true });
    }
    if (action === 'set') {
      if (!boss) return interaction.reply({ content: 'هذا الإجراء لمشرف الأكاديمية فقط.', ephemeral: true });
      A.setSession(id, slotIso);
      return interaction.update({ content: `📆 نُقل **${lesson.title}** إلى **${fmtInTz(new Date(slotIso), config.tz)}**`, components: [] });
    }
    if (action === 'skip') {
      if (!boss) return interaction.reply({ content: 'هذا الإجراء لمشرف الأكاديمية فقط.', ephemeral: true });
      A.cancelSession(id);
      stopStream();
      return interaction.update({ content: `⏭️ تُخطّيت حصة **${lesson.title}** — يبقى الدرس في قائمة الدورة.`, components: [] });
    }
    if (action === 'finish') {
      if (!boss && !isAdmin(interaction)) return interaction.reply({ content: 'إنهاء الحصة لمشرف الأكاديمية فقط.', ephemeral: true });
      await interaction.deferReply({ ephemeral: true }); // the public «انتهت الحصة» post is enough
      // bus: null crashed at the first post — no «انتهت الحصة», no quiz when finished from Discord
      await finishSession({ client: interaction.client, bus: createBus(interaction.client), sessionId: id });
      return interaction.editReply({ content: '✅ انتهت الحصة وسُجّل حضور الحاضرين.' });
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
    await interaction.deferUpdate();
    await interaction.editReply(await memberDashPayload(interaction.user.id, 'courses'));
    return interaction.followUp({
      content: res.already ? 'هذا الدرس مسجل من قبل ✅' : `✅ سُجّل إنجاز **${cp.next.title}**`,
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
        A.awardXp(interaction.user.id, r.question.xp, 'quiz');
      markMemberDirty(interaction.user.id);
        return interaction.reply({ content: '✅ إجابة صحيحة — أحسنت!', ephemeral: true });
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

  return interaction.reply({ content: 'زر غير معروف.', ephemeral: true });
}
