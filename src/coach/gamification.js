// Level-up detection, announcements, and auto-managed level roles.
// Domain functions award XP; the coach layer calls announceLevelUp() after an
// award with the user's pre-award XP total.
import { levelFor, xpTotal } from '../core/academy.js';
import { getSetting, getLevels } from '../core/db.js';
import { config } from '../core/config.js';
import { templates } from '../core/templates.js';

const fill = (text, vars) => text.replace(/\{\{(\w+)\}\}/g, (_, k) => vars?.[k] ?? '');

export async function announceLevelUp(client, userId, beforeXp, displayName) {
  const oldL = levelFor(beforeXp);
  const total = xpTotal(userId);
  const newL = levelFor(total);
  if (newL.name === oldL.name) return null;

  const guild = client?.guilds?.cache?.get(config.guildId);
  if (guild && getSetting('level_roles') === '1') {
    try { await ensureLevelRole(guild, newL, userId); }
    catch (e) { console.log('[coach] role error:', e.message); }
  }

  const chId = getSetting('channel_dashboard');
  if (client && chId) {
    try {
      const ch = await client.channels.fetch(chId);
      if (ch?.isTextBased()) {
        await ch.send(fill(templates.level_up, {
          mention: `<@${userId}>`, emoji: newL.emoji, level_name: newL.name, xp: total,
        }));
      }
    } catch (e) { console.log('[coach] level-up post failed:', e.message); }
  } else {
    console.log(`[coach:dryrun] ${displayName ?? userId} leveled up to ${newL.emoji} ${newL.name} (${total} XP)`);
  }
  return newL;
}

export async function ensureLevelRoles(guild) {
  if (getSetting('level_roles') !== '1') return;
  for (const lvl of getLevels()) {
    if (lvl.xp === 0) continue;
    const name = `${lvl.emoji} ${lvl.name}`;
    if (!guild.roles.cache.some(r => r.name === name)) {
      await guild.roles.create({ name, mentionable: false }).catch(() => null);
    }
  }
}

async function ensureLevelRole(guild, level, userId) {
  const name = `${level.emoji} ${level.name}`;
  let role = guild.roles.cache.find(r => r.name === name);
  if (!role) role = await guild.roles.create({ name, mentionable: false });
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;
  const levelNames = new Set(getLevels().filter(l => l.xp > 0).map(l => `${l.emoji} ${l.name}`));
  for (const r of member.roles.cache.values()) {
    if (levelNames.has(r.name) && r.name !== name) await member.roles.remove(r).catch(() => null);
  }
  await member.roles.add(role).catch(() => null);
}
