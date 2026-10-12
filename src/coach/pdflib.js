// PDF storage inside the existing «المكتبة الشرعية» forum: each book's PDF is
// posted as a tagged thread (its genre = forum tag). Members download through
// the bot — Discord attachment links expire, so files are re-fetched fresh on
// every request instead of shared as stale URLs.
import { ChannelType, AttachmentBuilder } from 'discord.js';
import * as A from '../core/academy.js';
import { config } from '../core/config.js';

const FORUM_NAME = '📚〡المكتبة・الشرعية';
const MAX_BYTES = 25 * 1024 * 1024; // bot upload cap — bigger PDFs must be split

export function findForum(client) {
  const guild = client?.guilds?.cache?.get(config.guildId);
  return guild?.channels.cache.find(c => c.type === ChannelType.GuildForum && c.name === FORUM_NAME) ?? null;
}

// genres are forum tags — create the tag when it doesn't exist yet
async function ensureTag(forum, name) {
  const existing = forum.availableTags?.find(t => t.name === name);
  if (existing) return existing.id;
  try {
    await forum.setAvailableTags([...(forum.availableTags ?? []), { name }]);
    const fresh = await forum.fetch();
    return fresh.availableTags.find(t => t.name === name)?.id ?? null;
  } catch { return null; }
}

// post (or replace) a book's PDF thread — returns { threadId, name, size }
export async function postBookPdf(client, book, buffer, fileName, genre) {
  const forum = findForum(client);
  if (!forum) throw new Error(`لم أجد فورم «${FORUM_NAME}»`);
  if (buffer.length > MAX_BYTES) throw new Error('الملف أكبر من ٢٥ ميغابايت — اضغط الـPDF أو قسّمه');
  const tagId = genre ? await ensureTag(forum, genre) : null;
  if (book.pdf_msg_id) {
    try { const old = await client.channels.fetch(book.pdf_msg_id); await old.delete(); } catch {}
  }
  const thread = await forum.threads.create({
    name: book.title.slice(0, 90),
    message: {
      content: `📖 **${book.title}**${genre ? ` — ${genre}` : ''} · ${book.total_pages} صفحة\nمن مكتبة الأكاديمية — التحميل متاح للأعضاء من لوحتهم الخاصة.`,
      files: [new AttachmentBuilder(buffer, { name: fileName })],
    },
    appliedTags: tagId ? [tagId] : [],
  });
  return { threadId: thread.id, name: fileName, size: buffer.length };
}

// re-fetch the stored PDF (fresh signed URL under the hood, always works)
export async function fetchBookPdf(client, book) {
  if (!book?.pdf_msg_id) return null;
  try {
    const thread = await client.channels.fetch(book.pdf_msg_id);
    const starter = await thread.fetchStarterMessage();
    const att = starter.attachments.first();
    if (!att) return null;
    const buffer = Buffer.from(await (await fetch(att.url)).arrayBuffer());
    return { buffer, name: book.pdf_name || att.name };
  } catch { return null; }
}

export async function deletePdfThread(client, book) {
  if (!book?.pdf_msg_id) return;
  try { const t = await client.channels.fetch(book.pdf_msg_id); await t.delete(); } catch {}
}
