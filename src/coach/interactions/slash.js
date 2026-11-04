// Slash commands (/lesson, /schedule, /setup, /myprogress, /quest, /books, /group, /pdf, /optout).
import * as A from '../../core/academy.js';
import { postBookPdf, deletePdfThread } from '../pdflib.js';
import { getSetting, setSetting } from '../../core/db.js';
import { zonedToUtc, fmtInTz } from '../../core/time.js';
import { config } from '../../core/config.js';
import { markMemberDirty } from '../memberdash.js';
import { e, QCAT, DAY_AR, statusAr, isAdmin } from './shared.js';

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
      return interaction.reply({ embeds: [e('✅ أُضيف الدرس', `#${id} — **${opts.getString('title')}**\nالترتيب: ${A.getLesson(id).position}`)] });
    }
    if (sub === 'list') {
      const rows = A.listLessons().map(l => {
        const s = A.sessionForLesson(l.id);
        return `#${l.id} · **${l.title}** · ${statusAr(l.status)}${s ? ` · 🗓️ ${fmtInTz(new Date(s.scheduled_at), tz)}` : ''}`;
      });
      return interaction.reply({ embeds: [e('📚 الدروس', rows.length ? rows.join('\n') : '_لا دروس بعد — أضف درساً بـ /lesson add_')] });
    }
    if (sub === 'remove') {
      const ok = A.removeLesson(opts.getInteger('id', true));
      return interaction.reply({ embeds: [e(ok ? '🗑️ حُذف' : '❌ غير موجود', ok ? 'حُذف الدرس وحصصه.' : 'لا يوجد درس بهذا الرقم.', ok ? 0x57f287 : 0xed4245)] });
    }
  }

  if (cmd === 'schedule') {
    const sub = opts.getSubcommand();
    if (sub === 'template') {
      const map = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
      const days = opts.getString('days', true).toLowerCase().split(',').map(d => map[d.trim()]).filter(d => d !== undefined);
      if (!days.length) return interaction.reply({ embeds: [e('❌ أيام غير صحيحة', 'اكتب الأيام هكذا: `sun,wed`')] });
      const time = opts.getString('time', true);
      if (!/^\d{2}:\d{2}$/.test(time)) return interaction.reply({ embeds: [e('❌ وقت غير صحيح', 'اكتب الوقت بصيغة `HH:mm`، مثل `20:00`')] });
      A.setTemplate({ days, time });
      return interaction.reply({ embeds: [e('✅ ضُبط الموعد الأسبوعي', `كل أسبوع يوم **${days.map(d => DAY_AR[d]).join(' و')}** الساعة **${time}** (${tz}).\nالآن نفّذ \`/schedule generate\`.`)] });
    }
    if (sub === 'generate') {
      try {
        const created = A.generateSchedule({});
        if (!created.length) return interaction.reply({ embeds: [e('📅 لا شيء للجدولة', 'كل الدروس المخططة لها حصص بالفعل.')] });
        const lines = created.map(s => `**${A.getLesson(s.lesson_id).title}** → ${fmtInTz(new Date(s.scheduled_at), tz)}`);
        return interaction.reply({ embeds: [e('📅 جُدولت الحصص', lines.join('\n'))] });
      } catch (err) {
        return interaction.reply({ embeds: [e('❌ تعذّرت الجدولة', err.message, 0xed4245)], ephemeral: true });
      }
    }
    if (sub === 'list') {
      const rows = A.listSessions({ future: true, limit: 20 }).map(s => {
        const l = A.getLesson(s.lesson_id);
        return `#${s.id} · **${l?.title ?? '?'}** · ${fmtInTz(new Date(s.scheduled_at), tz)} · ${statusAr(s.status)}`;
      });
      return interaction.reply({ embeds: [e('🗓️ الحصص القادمة', rows.length ? rows.join('\n') : '_لا حصص — استخدم /schedule template ثم generate_')] });
    }
    if (sub === 'move') {
      const id = opts.getInteger('id', true);
      const date = opts.getString('date', true), time = opts.getString('time', true);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) {
        return interaction.reply({ embeds: [e('❌ صيغة غير صحيحة', 'التاريخ = `YYYY-MM-DD`، الوقت = `HH:mm`', 0xed4245)], ephemeral: true });
      }
      const when = zonedToUtc(date, time, tz);
      A.setSession(id, when.toISOString());
      return interaction.reply({ embeds: [e('📆 نُقلت الحصة', `#${id} → **${fmtInTz(when, tz)}**`)] });
    }
    if (sub === 'cancel') {
      A.cancelSession(opts.getInteger('id', true));
      return interaction.reply({ embeds: [e('🚫 أُلغيت الحصة', `#${opts.getInteger('id')} — يبقى الدرس في الدورة.`)] });
    }
  }

  if (cmd === 'setup') {
    if (opts.getChannel('dashboard')) setSetting('channel_dashboard', opts.getChannel('dashboard').id);
    if (opts.getChannel('study_vc')) setSetting('study_vc', opts.getChannel('study_vc').id);
    if (opts.getRole('ping_role')) setSetting('ping_role', opts.getRole('ping_role').id);
    return interaction.reply({
      embeds: [e('⚙️ حُفظ الإعداد', [
        `قناة اللوحة: <#${getSetting('channel_dashboard')}>`,
        `قناة الحصص الصوتية: ${getSetting('study_vc') ? `<#${getSetting('study_vc')}>` : '_غير محددة_'}`,
        `رتبة التنبيه: ${getSetting('ping_role') ? `<@&${getSetting('ping_role')}>` : '_غير محددة_'}`,
      ].join('\n'))], ephemeral: true,
    });
  }

  if (cmd === 'myprogress') {
    const u = interaction.user;
    A.upsertParticipant(u.id, u.username);
    markMemberDirty(u.id); // ensures their private channel exists and is fresh
    const done = A.listProgress(u.id);
    const total = A.listLessons().length;
    const streak = A.currentStreak(u.id);
    const quests = A.listQuests().map(q =>
      `${QCAT[q.category] ?? '📜'} ${q.title}${A.questCompletedBy(q.id, u.id) ? ' — ✅' : ''}`);
    const courses = A.listCourses().map(c => {
      const cp = A.courseProgress(c.id, u.id);
      return `📖 **${c.title}** — ${cp.done}/${cp.total}${cp.next ? ` · التالي: ${cp.next.title}` : ' · كملها كاملة 🎉'}`;
    });
    return interaction.reply({
      embeds: [e(`📈 ${u.username}`, [
        `🔥 سلسلة: **${streak}** · تقدمك:`,
        courses.length ? `\n${courses.join('\n')}` : `الدروس: **${done.length}/${total}**`,
        quests.length ? `\n**قائمة الإنجازات:**\n${quests.join('\n')}` : '',
      ].join('\n'))], ephemeral: true,
    });
  }

  if (cmd === 'quest') {
    if (opts.getSubcommand() === 'list') {
      const rows = A.listQuests().map(q =>
        `${QCAT[q.category] ?? '📜'} **${q.title}** — ✅ ${A.questCompletionCount(q.id)}`);
      return interaction.reply({ embeds: [e('📜 قائمة الإنجازات', rows.join('\n') || '_فارغة — يضيف المشرف العناصر من اللوحة._')] });
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
    return interaction.reply({ content: newState ? '✅ رسائل المتابعة الخاصة **مفعّلة**.' : '🔕 رسائل المتابعة الخاصة **موقوفة**.', ephemeral: true });
  }

  return interaction.reply({ content: 'أمر غير معروف.', ephemeral: true });
}
