// Helpers shared by the interaction handlers: embed shorthand, Arabic labels, admin check,
// and the PDF publish form (used by the upload button and the right-click menu).
import { EmbedBuilder, ActionRowBuilder, PermissionFlagsBits, ModalBuilder, TextInputBuilder, TextInputStyle } from 'discord.js';
import { config } from '../../core/config.js';

export const e = (title, desc, color = 0x5865f2) => new EmbedBuilder().setTitle(title).setDescription(desc.slice(0, 4000)).setColor(color);
export const QCAT = { book: '📖', lecture: '📺', course: '🎓' };
export const DAY_AR = ['الأحد', 'الإثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
export const STATUS_AR = {
  planned: 'مخطط', done: 'مكتمل', skipped: 'متخطى', scheduled: 'مجدول', reminded: 'تم التذكير',
  live: 'مباشر', missed_poll: 'بانتظار موعد جديد', cancelled: 'ملغى',
};
export const statusAr = s => STATUS_AR[s] ?? s;

export function isAdmin(interaction) {
  return interaction.member?.permissions?.has(PermissionFlagsBits.ManageGuild) || config.bossIds.includes(interaction.user.id);
}

// the title/pages/category form shared by both entry points
export async function openUploadModal(interaction, sourceMsgId, fileName) {
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
