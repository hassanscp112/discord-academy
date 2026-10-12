// The member-facing library: a public read-only channel where every book in
// the academy has its own card + a «📝 سجّل صفحتك» button. Members browse,
// click, and start tracking their reading — no group or owner action needed.
import { ChannelType, PermissionFlagsBits, OverwriteType, ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } from 'discord.js';
import * as A from '../core/academy.js';
import { getDb } from '../core/db.js';
import { config } from '../core/config.js';
import { renderCard, bookCardHTML } from './card.js';

// NOTE: discord normalizes channel names (spaces -> dashes), so use the dashed form
const CHANNEL_NAME = '📚-المكتبة';

async function ensureLibraryChannel(client) {
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return null;
  const existing = guild.channels.cache.find(c => c.name === CHANNEL_NAME && c.type === ChannelType.GuildText);
  if (existing) return existing;
  try {
    const ch = await guild.channels.create({
      name: CHANNEL_NAME, type: ChannelType.GuildText,
      permissionOverwrites: [
        { id: guild.roles.everyone, type: OverwriteType.Role, deny: [PermissionFlagsBits.SendMessages] },
        { id: guild.client.user.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.ReadMessageHistory] },
      ],
    });
    console.log('[library] channel created:', ch.name);
    return ch;
  } catch (e) {
    console.log('[library] cannot create channel:', e.message);
    return null;
  }
}

async function postBookCard(client, ch, book) {
  const buf = await renderCard(bookCardHTML(book)).catch(() => null);
  const payload = buf
    ? { files: [new AttachmentBuilder(buf, { name: 'book.png' })] }
    : { content: `📖 **${book.title}** — ${book.total_pages} صفحة` };
  payload.components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`bkpage:${book.id}`).setLabel('📝 سجّل صفحتك').setStyle(ButtonStyle.Success),
  )];
  const m = await ch.send(payload);
  getDb().prepare('UPDATE books SET library_msg_id = ? WHERE id = ?').run(m.id, book.id);
  return m;
}

// post a new book to the library (called on book add)
export async function publishBook(client, book) {
  if (!client?.isReady?.()) return;
  const ch = await ensureLibraryChannel(client);
  if (!ch) return;
  try { await postBookCard(client, ch, book); } catch (e) { console.log('[library] post failed:', e.message); }
}

// remove a book's card when the book is deleted
export async function unpublishBook(client, bookId) {
  if (!client?.isReady?.()) return;
  const book = A.getBook(bookId);
  const msgId = book?.library_msg_id;
  if (!msgId) return;
  const guild = client.guilds.cache.get(config.guildId);
  const ch = guild?.channels.cache.find(c => c.name === CHANNEL_NAME && c.type === ChannelType.GuildText);
  if (!ch) return;
  const msg = await ch.messages.fetch(msgId).catch(() => null);
  if (msg) await msg.delete().catch(() => null);
}

// boot-time sync: make sure every book has a live card in the library channel
export async function syncLibrary(client) {
  if (!client?.isReady?.()) return;
  const ch = await ensureLibraryChannel(client);
  if (!ch) return;
  // which books already have a card in the channel (by button customId)?
  const posted = new Set();
  try {
    const msgs = await ch.messages.fetch({ limit: 100 });
    for (const m of msgs.values()) {
      for (const row of m.components ?? []) {
        for (const b of row.components ?? []) {
          if (b.customId?.startsWith('bkpage:')) posted.add(Number(b.customId.split(':')[1]));
        }
      }
    }
  } catch {}
  for (const book of A.listBooks()) {
    if (posted.has(book.id)) continue;
    try { await postBookCard(client, ch, book); } catch (e) { console.log(`[library] post failed for book ${book.id}:`, e.message); }
  }
}
