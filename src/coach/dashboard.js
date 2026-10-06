// The live "Course Dashboard" embed — one message, edited in place.
import { EmbedBuilder } from 'discord.js';
import { overview } from '../core/academy.js';
import { getSetting } from '../core/db.js';
import { fmtInTz, humanDuration } from '../core/time.js';
import { config } from '../core/config.js';

const MARK = 'ACADEMY_DASH_V1';
let lastUpdate = 0;
let cachedMessage = null;

export function buildDashboardEmbed() {
  const o = overview();
  const tz = config.tz;
  const embed = new EmbedBuilder()
    .setTitle('🎓 Academy Dashboard')
    .setColor(0x5865f2)
    .setFooter({ text: MARK + ' · auto-updates' });

  const ns = o.next_session;
  if (ns) {
    const when = new Date(ns.scheduled_at);
    const delta = humanDuration(when.getTime() - Date.now());
    embed.addFields({
      name: '⏰ Next session',
      value: `**${ns.lesson_title}**\n${fmtInTz(when, tz)} — in **${delta}**\n${ns.lesson_url ? `[Watch here](${ns.lesson_url})` : '_no link yet_'}`,
      inline: false,
    });
  } else {
    embed.addFields({ name: '⏰ Next session', value: '_Not scheduled yet — ask the coach!_', inline: false });
  }

  const cl = o.current_lesson;
  embed.addFields({
    name: '📖 Current lesson',
    value: cl
      ? `**${cl.title}**${cl.url ? `\n[Open on YouTube](${cl.url})` : ''}\n_mark ✅ on the lesson post when done_`
      : '_No lessons yet._',
    inline: false,
  });

  embed.addFields({
    name: '📊 Course progress',
    value: `**${o.lessons_done} / ${o.lessons_total}** lessons done · ${o.participants} member(s) enrolled`,
    inline: false,
  });

  if (o.leaderboard.length) {
    const medals = ['🥇', '🥈', '🥉'];
    const lines = o.leaderboard.slice(0, 5).map((r, i) => {
      const name = r.name ?? r.user_id;
      return `${medals[i] ?? '▫️'} **${name}** — ${r.xp} XP · ${r.level.emoji} ${r.level.name} · streak ${r.streak}`;
    });
    embed.addFields({ name: '🏆 Leaderboard', value: lines.join('\n').slice(0, 1024), inline: false });
  }

  if (o.active_quests.length) {
    const CAT = { book: '📖', lecture: '📺', course: '🎓' };
    const lines = o.active_quests.slice(0, 5).map(q =>
      `${CAT[q.category] ?? '📜'} **${q.title}** — ✅ ${q.done}`
    );
    embed.addFields({ name: '📜 Checklist', value: lines.join('\n').slice(0, 1024), inline: false });
  }

  return embed;
}

export async function refreshDashboard(client, { force = false } = {}) {
  const min = Number(getSetting('dashboard_refresh_minutes', '5')) * 60000;
  if (!force && Date.now() - lastUpdate < min) return;
  lastUpdate = Date.now();
  if (!client) return; // dry-run: embed state is derivable from the DB anyway
  const chId = getSetting('channel_dashboard');
  if (!chId) return;
  let ch;
  try { ch = await client.channels.fetch(chId); } catch { return; }
  if (!ch?.isTextBased()) return;

  try {
    if (cachedMessage) {
      await cachedMessage.edit({ embeds: [buildDashboardEmbed()] });
      return;
    }
    // fetchPins returns { items } in newer discord.js, a Collection in older ones
    let pinnedArr = [];
    try {
      const pins = await ch.messages.fetchPins();
      pinnedArr = Array.isArray(pins?.items) ? pins.items : (typeof pins?.values === 'function' ? [...pins.values()] : []);
    } catch { /* fall through to recent-message scan */ }
    const existing = pinnedArr.find(m => m.embeds?.some(e => e.footer?.text?.startsWith(MARK)))
      ?? [...(await ch.messages.fetch({ limit: 50 })).values()].find(m => m.author?.bot && m.embeds?.some(e => e.footer?.text?.startsWith(MARK)));
    if (existing) {
      cachedMessage = existing;
      await existing.edit({ embeds: [buildDashboardEmbed()] });
    } else {
      const msg = await ch.send({ embeds: [buildDashboardEmbed()] });
      await msg.pin().catch(() => null);
      cachedMessage = msg;
    }
  } catch (e) {
    console.log('[coach] dashboard refresh failed:', e.message);
  }
}

export function invalidateDashboardCache() { cachedMessage = null; }
export function markDashboardDirty() { lastUpdate = 0; }
