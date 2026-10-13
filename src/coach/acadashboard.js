// 📊 لوحة الأكاديمية: قناة عامة ببطاقة واحدة حية — إحصاءات الدورات
// والحصة القادمة وأبرز الأعضاء. تتحدث بعد كل حدث (مع خنق 10 دقائق).
import { ChannelType, PermissionFlagsBits, OverwriteType, AttachmentBuilder } from 'discord.js';
import * as A from '../core/academy.js';
import { getDb, getSetting, setSetting } from '../core/db.js';
import { config } from '../core/config.js';
import { fmtInTz } from '../core/time.js';
import { renderCard, academyCardHTML } from './card.js';

const CHANNEL_NAME = '📊-لوحة-الأكاديمية';
const THROTTLE_MS = 10 * 60 * 1000;
let lastRefresh = 0;

async function ensureChannel(client) {
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
    console.log('[acadash] channel created:', ch.name);
    return ch;
  } catch (e) {
    console.log('[acadash] cannot create channel:', e.message);
    return null;
  }
}

// القاعة الصوتية: «الحصة» — يعيد تسمية القاعة الحالية أو ينشئها
export async function ensureVoiceChannel(client) {
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return;
  let vc = getSetting('study_vc');
  try {
    if (vc) {
      const ch = await client.channels.fetch(vc).catch(() => null);
      if (ch?.isVoiceBased()) {
        if (ch.name !== 'الحصة') await ch.setName('الحصة', 'تسمية موحدة لقاعة الدروس').catch(() => {});
        return;
      }
    }
    const found = guild.channels.cache.find(c => c.type === ChannelType.GuildVoice && c.name === 'الحصة');
    const target = found ?? await guild.channels.create({ name: 'الحصة', type: ChannelType.GuildVoice });
    setSetting('study_vc', target.id);
    console.log('[acadash] voice channel ready:', target.name, target.id);
  } catch (e) { console.log('[acadash] voice channel setup failed:', e.message); }
}

function cardData() {
  const o = A.overview();
  const members = A.listParticipants().length;
  const bs = A.bookStats();
  return {
    now: fmtInTz(new Date(), config.tz),
    members,
    courses: o.courses.map(c => ({
      title: c.title, done: c.lessons_done, total: c.lessons_total,
      next: c.next_session ? `${fmtInTz(new Date(c.next_session.scheduled_at), config.tz)}` : null,
    })),
    lessonsDone: o.lessons_done, lessonsTotal: o.lessons_total,
    booksRead: bs.finished ?? bs.finished_books ?? 0,
    booksTotal: bs.total ?? bs.books ?? 0,
    top: o.leaderboard.slice(0, 3),
  };
}

// انشر/حدّث البطاقة (force يتجاوز الخنق)
export async function refreshAcademyDashboard(client, { force = false } = {}) {
  if (!client?.isReady?.()) return;
  if (!force && Date.now() - lastRefresh < THROTTLE_MS) return;
  lastRefresh = Date.now();
  try {
    const ch = await ensureChannel(client);
    if (!ch) return;
    const buf = await renderCard(academyCardHTML(cardData()));
    if (!buf) { console.log('[acadash] render unavailable'); return; }
    const payload = { files: [new AttachmentBuilder(buf, { name: 'academy.jpg' })], attachments: [] };
    const msgId = getSetting('academy_dash_msg');
    if (msgId) {
      try {
        const msg = await ch.messages.fetch(msgId);
        await msg.edit(payload);
        return;
      } catch { /* حُذفت — نعيد النشر */ }
    }
    const m = await ch.send(payload);
    setSetting('academy_dash_msg', m.id);
  } catch (e) { console.log('[acadash] refresh failed:', e.message); }
}
