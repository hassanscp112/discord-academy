// Modals, select menus and the message context menu.
import { AttachmentBuilder } from 'discord.js';
import * as A from '../../core/academy.js';
import { fetchBookPdf } from '../pdflib.js';
import { publishFromMessage, pdfAttachmentOf } from '../uploads.js';
import { markMemberDirty } from '../memberdash.js';
import { e, isAdmin, openUploadModal } from './shared.js';

// right-click a message with a PDF -> publish flow (same modal as the upload channel)
export async function handleContextMenu(interaction) {
  if (interaction.commandName !== '📚 نشر في المكتبة') {
    return interaction.reply({ content: 'أمر غير معروف.', ephemeral: true });
  }
  if (!isAdmin(interaction)) return interaction.reply({ content: 'للإدارة فقط.', ephemeral: true });
  const att = pdfAttachmentOf(interaction.targetMessage);
  if (!att) return interaction.reply({ content: 'لا يوجد ملف PDF في هذه الرسالة.', ephemeral: true });
  await openUploadModal(interaction, interaction.targetMessage.id, att.name);
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
  return interaction.reply({ content: 'قائمة غير معروفة.', ephemeral: true });
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
  return interaction.reply({ content: 'نموذج غير معروف.', ephemeral: true });
}
