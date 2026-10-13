// Per-member private progress channels — every member gets one channel only
// they (and the bot) can see, under a hidden category, with a pinned embed of
// their own progress that updates itself (same edit-in-place idea as the
// academy dashboard embed).
import {
  EmbedBuilder, ChannelType, PermissionFlagsBits, OverwriteType,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, StringSelectMenuBuilder,
} from 'discord.js';
import * as A from '../core/academy.js';
import { getDb, getSetting } from '../core/db.js';
import { fmtInTz, humanDuration } from '../core/time.js';
import { config } from '../core/config.js';
import { renderCard, memberCardHTML, listCardHTML, onboardingCardHTML } from './card.js';

const MARK = 'ACADEMY_MEMBER_DASH_V1';
const CATEGORY_NAME = '📊 تقدم الأعضاء';
const SWEEP_MIN_MS = 60_000;
// interactive dashboard views — the footer carries the active one
export const MEMBER_VIEWS = [
  ['overview', '📊 نظرة عامة'],
  ['courses', '📖 دوراتي'],
  ['books', '📚 كتبي'],
  ['quests', '📜 الإنجازات'],
  ['subs', '🔔 الإشعارات'],
];
const viewFooter = view => `${MARK}·${view}`;
// only a footer naming a real view counts; anything else (old formats) is the overview
const viewOf = embed => {
  const t = embed?.footer?.text ?? '';
  if (!t.startsWith(MARK)) return null;
  const v = (t.split('·')[1] ?? '').trim();
  return MEMBER_VIEWS.some(([name]) => name === v) ? v : 'overview';
};
const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const dirty = new Set(); // user_ids needing a refresh
const cachedMessages = new Map(); // userId -> pinned Message
const warned = new Set(); // don't spam permission errors
let lastSweep = 0;

export function markMemberDirty(userId) { if (userId) dirty.add(userId); }
export function markAllMembersDirty() { for (const p of A.listParticipants()) dirty.add(p.user_id); }

function warnOnce(key, e) {
  if (warned.has(key)) return;
  warned.add(key);
  console.log(`[memberdash] cannot create ${key}: ${e.message} — does the Coach role have Manage Channels?`);
}

function channelNameFor(p) {
  const base = (p.display_name || '').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 24);
  return `تقدم-${base || 'عضو-' + String(p.user_id).slice(-4)}`;
}

async function ensureCategory(guild) {
  const found = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === CATEGORY_NAME);
  if (found) return found;
  try {
    return await guild.channels.create({
      name: CATEGORY_NAME, type: ChannelType.GuildCategory,
      permissionOverwrites: [
        { id: guild.roles.everyone, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
        { id: guild.client.user.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ManageChannels] },
      ],
    });
  } catch (e) { warnOnce('category', e); return null; }
}

async function ensureMemberChannel(client, p) {
  const guild = client.guilds.cache.get(config.guildId);
  if (!guild) return null;
  let ch = p.private_channel_id
    ? guild.channels.cache.get(p.private_channel_id) ?? await client.channels.fetch(p.private_channel_id).catch(() => null)
    : null;
  if (ch) {
    await ensureBotOverwrite(ch).catch(e => warnOnce('overwrite:' + ch.id, e));
    return ch;
  }
  const cat = await ensureCategory(guild);
  if (!cat) return null;
  try {
    ch = await guild.channels.create({
      name: channelNameFor(p), type: ChannelType.GuildText, parent: cat.id,
      permissionOverwrites: [
        { id: guild.roles.everyone, type: OverwriteType.Role, deny: [PermissionFlagsBits.ViewChannel] },
        { id: p.user_id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AddReactions] },
        { id: guild.client.user.id, type: OverwriteType.Member, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels] },
      ],
    });
  } catch (e) { warnOnce('channel:' + p.user_id, e); return null; }
  getDb().prepare('UPDATE participants SET private_channel_id = ? WHERE user_id = ?').run(ch.id, p.user_id);
  console.log(`[memberdash] private channel for ${p.display_name || p.user_id}: #${ch.name}`);
  return ch;
}

// channels created with explicit overwrites don't inherit the category's
// bot-allow — make sure the Coach can actually see and post in each one
async function ensureBotOverwrite(ch) {
  const me = ch.client.user;
  const existing = ch.permissionOverwrites?.cache.get(me.id);
  if (existing?.allow?.has(PermissionFlagsBits.ViewChannel) && existing.allow.has(PermissionFlagsBits.SendMessages)) return;
  await ch.permissionOverwrites.edit(me, {
    ViewChannel: true, SendMessages: true, ReadMessageHistory: true, ManageChannels: true,
  });
  console.log(`[memberdash] restored Coach access to #${ch.name}`);
}

const BAR_SLOTS = 12;
function bar(done, total) {
  if (!total) return '░'.repeat(BAR_SLOTS);
  const f = Math.min(BAR_SLOTS, Math.round((done / total) * BAR_SLOTS));
  return '█'.repeat(f) + '░'.repeat(BAR_SLOTS - f);
}

export function buildMemberEmbed(userId) {
  const p = A.getParticipant(userId);
  const xp = A.xpTotal(userId);
  const lvl = A.levelFor(xp);
  const streak = A.currentStreak(userId);
  const rank = A.xpLeaderboard(200).findIndex(r => r.user_id === userId) + 1;
  const embed = new EmbedBuilder()
    .setTitle(`📊 تقدمك في الأكاديمية`)
    .setColor(0xC9992E)
    .setFooter({ text: viewFooter('overview') });

  embed.addFields({
    name: '⚡ نقاطك',
    value: `🔥 سلسلة **${streak}** · واصل التقدم!`,
    inline: false,
  });

  for (const c of A.listCourses()) {
    const cp = A.courseProgress(c.id, userId);
    const nextLine = cp.next ? `\n**التالي:** ${cp.next.title}` : '\n🎉 أكملت الدورة كاملة';
    embed.addFields({
      name: `📖 ${c.title}`,
      value: `\`${bar(cp.done, cp.total)}\` **${cp.done}/${cp.total}**${nextLine}`.slice(0, 1024),
      inline: false,
    });
  }

  const ns = A.nextSession();
  embed.addFields({
    name: '⏰ الحصة القادمة',
    value: ns
      ? `**${ns.lesson_title}**\n${fmtInTz(new Date(ns.scheduled_at), config.tz)} — بعد ${humanDuration(new Date(ns.scheduled_at).getTime() - Date.now())}`
      : 'لا حصة مجدولة بعد',
    inline: false,
  });

  const CAT = { book: '📖', lecture: '📺', course: '🎓' };
  const quests = A.listQuests();
  if (quests.length) {
    const lines = quests.slice(0, 10).map(q =>
      `${CAT[q.category] ?? '📜'} ${q.title} ${A.questCompletedBy(q.id, userId) ? '✅' : '⬜'}`);
    embed.addFields({ name: '📜 قائمة الإنجاز', value: lines.join('\n').slice(0, 1024), inline: false });
  }

  // my books: reading progress with pages (books being read / finished)
  const shelf = A.bookShelf(userId).filter(b => b.page > 0 || b.finished).slice(0, 8);
  if (shelf.length) {
    const lines = shelf.map(b =>
      b.finished ? `✅ **${b.title}** — أكملته 🎉`
      : `\`${bar(b.page, b.total_pages)}\` ${b.page}/${b.total_pages} — ${b.title}`);
    embed.addFields({ name: '📚 كتبي', value: lines.join('\n').slice(0, 1024), inline: false });
  }
  return embed;
}

// ---------- interactive dashboard: one embed + nav/action buttons ----------
// Buttons + rows per view; userId needed because actions target this member.
export function memberDashComponents(view, userId) {
  const rows = [new ActionRowBuilder().addComponents(MEMBER_VIEWS.map(([v, label]) =>
    new ButtonBuilder()
      .setCustomId(`mview:${v}`).setLabel(label)
      .setStyle(v === view ? ButtonStyle.Primary : ButtonStyle.Secondary)
      .setDisabled(v === view)))];

  if (view === 'courses') {
    for (const c of A.listCourses().slice(0, 4)) {
      const cp = A.courseProgress(c.id, userId);
      if (!cp.total) continue;
      if (cp.next) {
        rows.push(new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`mcomplete:${c.id}`)
            .setLabel(`✅ أنهيت: ${trunc(cp.next.title, 66)}`)
            .setStyle(ButtonStyle.Success)));
      } else {
        rows.push(new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`mnoop:${c.id}`).setLabel(`🎓 ${trunc(c.title, 70)} — مكتملة`)
            .setStyle(ButtonStyle.Secondary).setDisabled(true)));
      }
    }
  }

  if (view === 'books') {
    // any book in the library can be tracked personally — no group needed
    const pdfs = A.listBooks().filter(b => b.pdf_msg_id);
    const mine = A.bookShelf(userId).filter(b => !b.finished).slice(0, pdfs.length ? 3 : 4);
    for (const b of mine) {
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`bkpage:${b.id}`)
          .setLabel(`📝 ${trunc(b.title, 60)} — ${b.page > 0 ? `صفحة ${b.page}/${b.total_pages}` : 'ابدأ القراءة'}`)
          .setStyle(ButtonStyle.Success)));
    }
    // PDF downloads straight from the member's own channel
    if (pdfs.length) {
      rows.push(new ActionRowBuilder().addComponents(
        new StringSelectMenuBuilder()
          .setCustomId('pdfget')
          .setPlaceholder('⬇️ حمّل كتاباً بصيغة PDF')
          .addOptions(pdfs.slice(0, 25).map(b => ({
            label: trunc(b.title, 100),
            value: String(b.id),
            description: trunc(`${b.genre ? b.genre + ' · ' : ''}${b.pdf_size ? (b.pdf_size / 1048576).toFixed(1) + 'MB' : 'PDF'}`, 100),
          })))));
    }
  }

  if (view === 'subs') {
    const subs = A.subscribedCourses(userId);
    for (const c of A.listCourses().slice(0, 4)) {
      const on = subs.has(c.id);
      rows.push(new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`sub:${c.id}`)
          .setLabel(`${on ? '🔕 إلغاء الإشعار' : '🔔 أشعرني'} — ${trunc(c.title, 55)}`)
          .setStyle(on ? ButtonStyle.Primary : ButtonStyle.Secondary)));
    }
  }

  if (view === 'quests') {
    const open = A.listQuests().filter(q => !A.questCompletedBy(q.id, userId));
    const CAT = { book: '📖', lecture: '📺', course: '🎓' };
    for (let i = 0; i < open.length && rows.length < 5; i += 5) {
      rows.push(new ActionRowBuilder().addComponents(
        open.slice(i, i + 5).map(q =>
          new ButtonBuilder().setCustomId(`quest:check:${q.id}`)
            .setLabel(`✅ ${trunc(`${CAT[q.category] ?? '📜'} ${q.title}`, 78)}`)
            .setStyle(ButtonStyle.Success))));
    }
  }
  return rows;
}

export function buildMemberView(userId, view = 'overview') {
  let embed;
  if (view === 'overview') embed = buildMemberEmbed(userId);
  else if (view === 'courses') {
    embed = new EmbedBuilder().setTitle('📖 دوراتي').setColor(0xC9992E).setFooter({ text: viewFooter('courses') });
    for (const c of A.listCourses()) {
      const cp = A.courseProgress(c.id, userId);
      embed.addFields({
        name: `📖 ${c.title}`,
        value: `\`${bar(cp.done, cp.total)}\` **${cp.done}/${cp.total}**\n${cp.next ? `**التالي:** ${cp.next.title}` : '🎉 أكملتها كاملة'}`.slice(0, 1024),
        inline: false,
      });
    }
    if (!embed.data.fields?.length) embed.setDescription('لا دورات بعد.');
  } else if (view === 'books') {
    embed = new EmbedBuilder().setTitle('📚 كتبي').setColor(0xC9992E).setFooter({ text: viewFooter('books') });
    const shelf = A.bookShelf(userId);
    const started = shelf.filter(b => b.page > 0 || b.finished);
    const shown = started.length ? started : shelf.slice(0, 10);
    embed.setDescription(shown.length
      ? shown.map(b => b.finished
        ? `✅ **${b.title}** — أكملته 🎉`
        : `📖 **${b.title}** — صفحة **${b.page}** من ${b.total_pages}`).join('\n').slice(0, 4000)
      : 'لا كتب بعد — انضم لمجموعة قراءة!');
  } else if (view === 'quests') {
    embed = new EmbedBuilder().setTitle('📜 قائمة الإنجاز').setColor(0xC9992E).setFooter({ text: viewFooter('quests') });
    const CAT = { book: '📖', lecture: '📺', course: '🎓' };
    const all = A.listQuests();
    const mine = new Set();
    const lines = all.map(q => {
      const done = A.questCompletedBy(q.id, userId);
      if (done) mine.add(q.id);
      return `${done ? '✅' : '⬜'} ${CAT[q.category] ?? '📜'} **${q.title}**`;
    });
    embed.setDescription(lines.length
      ? `${lines.join('\n').slice(0, 4000)}\n\n_أنجزت ${mine.size} من ${all.length}_`
      : 'القائمة فارغة.');
  } else if (view === 'subs') {
    embed = new EmbedBuilder().setTitle('🔔 الإشعارات').setColor(0xC9992E).setFooter({ text: viewFooter('subs') });
    const subs = A.subscribedCourses(userId);
    const lines = A.listCourses().map(c =>
      `${subs.has(c.id) ? '🔔' : '🔕'} **${c.title}** — ${subs.has(c.id) ? 'ستُشعَر بحصص هذه الدورة' : 'بدون إشعار'}`);
    embed.setDescription(lines.length
      ? `${lines.join('\n').slice(0, 4000)}\n\n_عند وجود مشتركين تُرسل التنبيهات بأسمائهم بدل الدور العام_`
      : 'لا دورات بعد.');
  } else return null;
  return { embeds: [embed], components: memberDashComponents(view, userId) };
}

// ---------- rendered image cards (HTML -> PNG), attached above the embed ----------
function memberCardData(userId) {
  const p = A.getParticipant(userId);
  const xp = A.xpTotal(userId);
  const ns = A.nextSession();
  return {
    name: p?.display_name || 'عضو', xp,
    level: A.levelFor(xp), streak: A.currentStreak(userId),
    rank: A.xpLeaderboard(200).findIndex(r => r.user_id === userId) + 1,
    lessonsDone: A.listProgress(userId).length, lessonsTotal: A.listLessons().length,
    courses: A.listCourses().map(c => {
      const cp = A.courseProgress(c.id, userId);
      return { title: c.title, done: cp.done, total: cp.total, next: cp.next?.title ?? null };
    }),
    books: A.bookShelf(userId).filter(b => b.page > 0 || b.finished),
    nextSession: ns
      ? { title: ns.lesson_title, when: `${fmtInTz(new Date(ns.scheduled_at), config.tz)} — بعد ${humanDuration(new Date(ns.scheduled_at).getTime() - Date.now())}` }
      : null,
    quests: {
      done: A.listQuests().filter(q => A.questCompletedBy(q.id, userId)).length,
      total: A.listQuests().length,
    },
  };
}

function viewCardHTML(userId, view) {
  const CAT = { book: '📖', lecture: '📺', course: '🎓' };
  if (view === 'overview') return memberCardHTML(memberCardData(userId));
  if (view === 'courses') {
    const d = memberCardData(userId);
    return listCardHTML({
      icon: '📖', title: 'دوراتي', subtitle: `${d.lessonsDone}/${d.lessonsTotal} درساً`,
      rows: d.courses.map(c => ({
        t: c.title, sub: c.next ? 'التالي: ' + c.next : 'مكتملة 🎉',
        done: c.done, total: c.total, right: `${c.done}/${c.total}`,
      })),
    });
  }
  if (view === 'books') {
    const shelf = A.bookShelf(userId);
    const pdfCount = shelf.filter(b => b.pdf_msg_id).length;
    const rows = shelf.filter(b => b.page > 0 || b.finished).map(b => ({
      t: b.title, done: b.page, total: b.total_pages,
      right: b.finished ? '✅' : `${b.page}/${b.total_pages}`,
    }));
    const open = shelf.filter(b => !(b.page > 0 || b.finished)).slice(0, 3)
      .map(b => ({ t: b.title, done: 0, total: b.total_pages, right: 'لم تبدأه' }));
    return listCardHTML({
      icon: '📚', title: 'كتبي',
      subtitle: `${rows.length} قيد القراءة${pdfCount ? ` · ⬇️ ${pdfCount} للتحميل` : ''}`,
      rows: [...rows, ...open],
    });
  }
  if (view === 'quests') {
    const all = A.listQuests();
    return listCardHTML({
      icon: '📜', title: 'قائمة الإنجاز',
      subtitle: all.length ? `${all.filter(q => A.questCompletedBy(q.id, userId)).length}/${all.length}` : '',
      rows: all.map(q => ({ t: `${CAT[q.category] ?? '📜'} ${q.title}`, ok: A.questCompletedBy(q.id, userId) })),
    });
  }
  if (view === 'subs') {
    const subs = A.subscribedCourses(userId);
    const courses = A.listCourses();
    return listCardHTML({
      icon: '🔔', title: 'الإشعارات',
      subtitle: courses.length ? `${courses.filter(c => subs.has(c.id)).length} من ${courses.length} مفعّل` : '',
      rows: courses.map(c => ({ t: c.title, ok: subs.has(c.id) })),
    });
  }
  return null;
}

// full payload for a member dashboard message. With a working renderer the
// card IS the message: just the image + buttons, no text at all. Falls back
// to the text embed only when no browser can render.
export async function memberDashPayload(userId, view = 'overview') {
  const base = buildMemberView(userId, view);
  if (!base) return null;
  try {
    const buf = await renderCard(viewCardHTML(userId, view));
    if (buf) {
      return {
        embeds: [],
        components: base.components,
        files: [new AttachmentBuilder(buf, { name: 'card.jpg' })],
        attachments: [], // replace the previous card on edits
      };
    }
  } catch { /* no browser or render hiccup -> plain embed */ }
  return { ...base, attachments: [] }; // clear any stale card image on edits
}

// a member-dashboard message: has our tab buttons (or the legacy footer mark)
const isDashMessage = m =>
  m.author?.bot && (
    m.components?.some(r => r.components?.some(b => b.customId?.startsWith('mview:'))) ||
    m.embeds?.some(e => e.footer?.text?.startsWith(MARK))
  );

// which tab a message is showing: the disabled nav button, else legacy footer
const viewOfMsg = m => {
  const nav = m.components?.[0]?.components?.find(b => b.customId?.startsWith('mview:') && b.disabled);
  if (nav) return nav.customId.split(':')[1];
  return viewOf(m.embeds?.[0]);
};

async function refreshOne(client, userId) {
  const p = A.getParticipant(userId);
  if (!p) return;
  const ch = await ensureMemberChannel(client, p);
  if (!ch) return;
  try {
    let msg = cachedMessages.get(userId);
    if (msg) {
      // a member sitting on another tab keeps it — refresh only the overview
      if ((viewOfMsg(msg) ?? 'overview') === 'overview')
        await msg.edit(await memberDashPayload(userId, 'overview'));
      return;
    }
    let existing = null;
    try {
      const pins = await ch.messages.fetchPins();
      const arr = Array.isArray(pins?.items) ? pins.items : (typeof pins?.values === 'function' ? [...pins.values()] : []);
      existing = arr.find(isDashMessage);
    } catch { /* fall through to recent scan */ }
    if (!existing) existing = [...(await ch.messages.fetch({ limit: 20 })).values()].find(isDashMessage);
    if (existing) {
      cachedMessages.set(userId, existing);
      if ((viewOfMsg(existing) ?? 'overview') === 'overview')
        await existing.edit(await memberDashPayload(userId, 'overview'));
    } else {
      const m = await ch.send(await memberDashPayload(userId, 'overview'));
      await m.pin().catch(() => null);
      cachedMessages.set(userId, m);
    }
  } catch (e) {
    console.log(`[memberdash] refresh failed for ${userId}:`, e.message);
    cachedMessages.delete(userId);
  }
}

// Sweep dirty members — called from the 20s tick; throttled to once a minute.
export async function refreshMemberDashboards(client, { force = false } = {}) {
  if (!client?.isReady?.()) return;
  if (!dirty.size) return;
  if (!force && Date.now() - lastSweep < SWEEP_MIN_MS) return;
  lastSweep = Date.now();
  const users = [...dirty];
  dirty.clear();
  for (const u of users) await refreshOne(client, u);
}

// pinned onboarding guide in the announcements channel (idempotent)
export async function postOnboarding(client) {
  if (!client?.isReady?.()) return;
  const chId = getSetting('channel_dashboard');
  if (!chId) return;
  const ch = await client.channels.fetch(chId).catch(() => null);
  if (!ch) return;
  const isOnboarding = m =>
    m.author?.bot && m.components?.some(r => r.components.some(b => b.customId?.startsWith('onboard:')));
  let existing = null;
  try {
    const pins = await ch.messages.fetchPins();
    const arr = Array.isArray(pins?.items) ? pins.items : [...(pins?.values?.() ?? [])];
    existing = arr.find(isOnboarding);
  } catch {}
  if (!existing) existing = [...(await ch.messages.fetch({ limit: 30 })).values()].find(isOnboarding);
  const buf = await renderCard(onboardingCardHTML());
  const payload = buf
    ? { files: [new AttachmentBuilder(buf, { name: 'onboarding.png' })] }
    : { content: '🎓 أهلاً بك في الأكاديمية — احضر أول حصة لتظهر لوحتك الخاصة.' };
  payload.components = [new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('onboard:me').setLabel('📊 افتح لوحتي').setStyle(ButtonStyle.Primary),
  )];
  if (existing) await existing.edit(payload);
  else {
    const m = await ch.send(payload);
    await m.pin().catch(() => null);
    console.log('[memberdash] onboarding guide pinned');
  }
}
