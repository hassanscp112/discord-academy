// Mods upload PDFs by dropping them in «📥-رفع-الكتب»: the bot answers with a
// completion panel (title / pages / category via modal), then publishes the
// book to the sharia forum + the library channel. Requires the Message
// Content intent (COACH_MSG_INTENT=1) — until then, the right-click app
// command «نشر في المكتبة» covers the same flow on any message with a PDF.
import { ChannelType, PermissionFlagsBits, OverwriteType, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import * as A from '../core/academy.js';
import { config } from '../core/config.js';
import { postBookPdf, deletePdfThread } from './pdflib.js';
import { publishBook } from './library.js';

const CHANNEL_NAME = '📥-رفع-الكتب';

export function isMod(member) {
  return !!member?.permissions?.has?.(PermissionFlagsBits.ManageGuild) || config.bossIds.includes(member?.id);
}

export async function ensureUploadChannel(client) {
  const guild = client?.guilds?.cache?.get(config.guildId);
  if (!guild) return null;
  const found = guild.channels.cache.find(c => c.name === CHANNEL_NAME && c.type === ChannelType.GuildText);
  if (found) return found;
  try {
    const ch = await guild.channels.create({
      name: CHANNEL_NAME, type: ChannelType.GuildText,
      permissionOverwrites: [
        // visible to all, but only staff (grant Send to your mod roles manually) post here
        { id: guild.roles.everyone, type: OverwriteType.Role, deny: [PermissionFlagsBits.SendMessages] },
        { id: guild.client.user.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory] },
      ],
    });
    console.log('[uploads] channel created:', ch.name);
    return ch;
  } catch (e) { console.log('[uploads] cannot create channel:', e.message); return null; }
}

export function pdfAttachmentOf(message) {
  return message?.attachments?.find(a => a.name?.toLowerCase().endsWith('.pdf') || a.contentType === 'application/pdf') ?? null;
}

// messageCreate hook — active only with the Message Content intent
export async function onUploadMessage(client, message) {
  if (message.author?.bot || !isMod(message.member)) return;
  const att = pdfAttachmentOf(message);
  if (!att) return;
  const ch = await ensureUploadChannel(client);
  if (!ch || message.channelId !== ch.id) return;
  await message.reply({
    content: `📥 استلمت **${att.name}** (${(att.size / 1048576).toFixed(1)}MB)\nأكمل البيانات للنشر في المكتبة:`,
    components: [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId(`pdfup:btn:${message.id}`).setLabel('✏️ العنوان والصفحات والتصنيف').setStyle(ButtonStyle.Primary),
    )],
  }).catch(() => {});
}

// full publish pipeline shared by the panel button, the app command, and /pdf
export async function publishFromMessage(client, { message, title, pages, genre }) {
  const att = pdfAttachmentOf(message);
  if (!att) throw new Error('لم أجد ملف PDF في الرسالة.');
  let book = A.findBookByTitle(title);
  const isNew = !book;
  if (isNew) book = A.getBook(A.addBook({ title, totalPages: pages || 200 }));
  const buf = Buffer.from(await (await fetch(att.url)).arrayBuffer());
  const r = await postBookPdf(client, book, buf, att.name, genre);
  A.setBookPdf(book.id, { msgId: r.threadId, name: att.name, size: buf.length, genre });
  if (isNew) await publishBook(client, A.getBook(book.id));
  return { book: A.getBook(book.id), isNew, threadId: r.threadId };
}

// pinned instructions in the upload channel (idempotent)
export async function postUploadInstructions(client) {
  const ch = await ensureUploadChannel(client);
  if (!ch) return;
  const isIt = m => m.author?.bot && (m.content ?? '').startsWith('📥 **رفع الكتب');
  let existing = null;
  try {
    const pins = await ch.messages.fetchPins();
    const arr = Array.isArray(pins?.items) ? pins.items : [...(pins?.values?.() ?? [])];
    existing = arr.find(isIt);
  } catch {}
  if (!existing) existing = [...(await ch.messages.fetch({ limit: 20 })).values()].find(isIt);
  const content = [
    '📥 **رفع الكتب إلى المكتبة**',
    '1. أرفق ملف الـPDF هنا (حتى ٢٥ ميغابايت)',
    '2. أكمل البيانات: عنوان الكتاب، عدد الصفحات، والتصنيف (عقيدة / فقه / حديث…)',
    '3. يُنشر تلقائياً في فورم المكتبة الشرعية تحت تصنيفه، ويصبح متاحاً للتحميل من لوحات الأعضاء',
    '',
    'يمكنك أيضاً النقر بالزر الأيمن على أي رسالة تحتوي PDF ← **التطبيقات** ← **📚 نشر في المكتبة**',
  ].join('\n');
  if (existing) await existing.edit({ content, components: existing.components }).catch(() => {});
  else {
    const m = await ch.send(content);
    await m.pin().catch(() => null);
  }
}
