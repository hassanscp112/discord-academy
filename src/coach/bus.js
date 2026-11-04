// Thin messaging abstraction so every engine works identically with Discord
// or in dry-run (COACH_DISABLE_DISCORD=1) mode.
import { config } from '../core/config.js';
import { getSetting } from '../core/db.js';

export function createBus(client) {
  const log = (...a) => console.log('[coach:dryrun]', ...a);
  async function channel(key) {
    if (!client) return null;
    const id = getSetting(key);
    if (!id) return null;
    try { return await client.channels.fetch(id); } catch { return null; }
  }
  return {
    client,
    dryRun: !client,
    async postTo(key, payload) {
      const ch = await channel(key);
      if (!ch) { log(`[${key}]`, payload.content ?? '(embed)'); return null; }
      return ch.send(payload);
    },
    async dm(userId, payload) {
      if (!client) { log(`[dm->${userId}]`, payload.content ?? '(embed)'); return null; }
      try { const u = await client.users.fetch(userId); return await u.send(payload); }
      catch (e) { console.log('[coach] dm failed:', e.message); return null; }
    },
    async bossDm(payload) {
      // own arrays per recipient: discord.js mutates `attachments` while resolving uploads,
      // so one shared payload breaks the second owner's DM (e.g. the daily backup file)
      for (const id of config.bossIds) {
        await this.dm(id, {
          ...payload,
          ...(payload.files ? { files: [...payload.files] } : {}),
          ...(payload.attachments ? { attachments: [...payload.attachments] } : {}),
        });
      }
    },
  };
}
