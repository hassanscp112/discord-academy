# 6 — Deployment & Operations Runbook

## Hosting decision (context — why things are where they are)

The owner has **no credit card**, so only no-card options exist:
- ❌ Oracle Cloud Always Free — requires a card (files removed 2026-11).
- ❌ Serverless PaaS (Vercel, Render, Koyeb) — no UDP voice / card-gated.
- ⏸️ Old Huawei MediaPad tablet (Termux) — primary until 2026-10, now **stopped**.
- ✅ **Primary since 2026-11-04: bot-hosting.net** — Node.js 24 container (Pterodactyl "yolks" image, Debian 13), Hetzner nodes in Finland/Germany.
- ✅ Fallback: the owner's Windows PC (`AcademyCoach` scheduled task, disabled).

**Only ever run ONE instance** — two bots double-post everything.

## PRIMARY — bot-hosting.net

| Item | Value |
|---|---|
| Panel | bot-hosting.net → deployment «هدى» |
| Runtime | Node.js 24, entry file `scripts/start.js` (Startup tab) |
| Code | GitHub `hassanscp112/discord-academy`, branch `main` (public repo — never commit `.env`/`data/`) — **Auto-pull at restart** on |
| Dashboard | HTTPS `*.apps.bot-hosting.cloud` address shown in the Domains tab (not written here — the repo is public), proxied to `SERVER_PORT` |
| Plan limits seen | 384 MB RAM, 20 % CPU, 1.5 GB disk — bot + Chrome ≈ 150–220 MB |
| Container facts | ffmpeg on PATH; all Chromium libs present; no root/apt; `TZ` forced to `Europe/Helsinki` → set `ACADEMY_TZ` |

### Ship a change
1. `npm test` green → commit.
2. `git push origin master:main`.
3. Panel → **Restart** (it fetches `main` first; the GitHub tab shows "In the container: <sha>").
4. Console should show: `[start] yt-dlp … OK`, `ffmpeg: using PATH`, `browser: … OK`, `emoji font: OK`, `started (discord: on, tz: Asia/Riyadh)`, `[card] warm-up ok`.

First boot on a fresh container also downloads yt-dlp (≈40 MB), chrome-headless-shell (≈100 MB) and the Noto emoji font (10 MB) into `tools/` and `~/.local/share/fonts`.

### Environment tab (required)
`COACH_TOKEN` (**secret**), `GUILD_ID`, `BOSS_IDS`, `DASH_PASSWORD` (**secret**, 12+ chars), `ACADEMY_TZ=Asia/Riyadh`,
`TRUST_PROXY=1`. Don't set `PORT` — the host provides `SERVER_PORT`. `COACH_DISABLE_DISCORD` must be absent or empty.

### Data, backups, cookies — all from the dashboard (الإعدادات ← النظام)
- **Restore a database**: «♻️ استعادة قاعدة بيانات» — validated (SQLite + academy tables), refused during a live class, the current DB is saved to `data/backups/academy-before-restore-*.db` first, then swapped live.
- **Backups**: daily at `backup_hour` (default 4 AM academy time): `VACUUM INTO data/backups/academy-<date>.db` (7 kept) and a `.db.gz` DM to every `BOSS_IDS` user. «⬇️ تحميل نسخة احتياطية الآن» downloads one on demand. The host's own backups (Backups tab) are a second layer.
- **YouTube cookies**: «⬆️ رفع cookies.txt» (validated: Netscape format with youtube.com lines). **Mandatory on this host** — datacenter IPs get "Sign in to confirm you're not a bot". Export with the «Get cookies.txt LOCALLY» browser extension from a dedicated Google account, or `scripts/cdp-cookies.mjs`. Refresh when the owner gets a «🔇 الحصة بلا صوت» DM.

## FALLBACK — Windows PC

- Task `AcademyCoach` (register via `deploy/install-task.ps1`): at logon, hidden launcher (`coach-start.vbs` → `coach-start.cmd` → `node src/coach/index.js >> data\coach.log`). `coach-start.cmd` has no restart loop — restart with `schtasks /Run /TN AcademyCoach`.
- Keep it **disabled** while bot-hosting.net runs.

## Retired — Android tablet (Termux)

`~/discord-academy` cloned from a git bundle, supervisor `~/.termux/boot/academy.sh` (`while true; do node src/coach/index.js >> ~/coach.log; sleep 10; done`), SSH on 8022. Gotchas if revived: EMUI battery manager kills Termux (exempt it); a wrong clock breaks TLS. Its last `data/academy.db` is the most recent pre-migration data.

## Environment variables (`.env`, template `.env.example`)

| Var | Required | Meaning |
|---|---|---|
| `COACH_TOKEN` | ✔ | bot token |
| `GUILD_ID` | ✔ | the مِداد server id |
| `DASH_PASSWORD` | ✔ | web dashboard login (12+ chars when public) |
| `BOSS_IDS` | – | comma list; admin buttons + owner DMs (health, backups, silent-class alerts) |
| `TZ` / `ACADEMY_TZ` | – | academy timezone; `ACADEMY_TZ` wins (container hosts force `TZ`) |
| `DB_PATH` | – | default `./data/academy.db` |
| `PORT` / `SERVER_PORT` | – | dashboard port (default 8420); `SERVER_PORT` wins |
| `TRUST_PROXY` | – | `1` behind an HTTPS proxy: login lockout uses the real client IP |
| `COACH_DISABLE_DISCORD` | – | any non-empty value = dry-run (web + engines, no Discord) |
| `COACH_MSG_INTENT` | – | `1` = MessageContent intent for PDF-drop auto-detect (also enable in the dev portal) |
| `YTDLP_PATH` / `FFMPEG_PATH` / `YTDLP_COOKIES` | – | binary + cookies overrides (see `src/coach/ytdlp.js`) |
| `BROWSER_PATH` / `CARD_TIMEOUT_MS` | – | Chromium for cards / render timeout (default 60000) |
| `AUDIO_CACHE_DIR` / `BACKUP_DIR` | – | default `data/cache` / `data/backups` (the test suite points them elsewhere) |
| `AUDIO_BACKEND`, `LAVALINK_*` | – | optional Lavalink audio node — **not recommended**, see docs/7 |

## Discord app configuration (dev portal)

- Intents: Server Members ✔; Message Content only if `COACH_MSG_INTENT=1`.
- Permissions used: Send Messages, Embed Links, Attach Files, Read History, View Channels, Connect, Speak, Manage Roles (course/learner roles), Manage Channels (member channels); ManageMessages **wanted** for pinning (pins silently fail without it).

## Monitoring & maintenance

- **Owner DMs**: first occurrence of each error (then ≤1/h), 9 AM heartbeat, 4 AM backup, «🔇 الحصة بلا صوت» when a live class stays silent 2.5 min.
- **Dashboard «النظام» panel**: cookies age (red after 30 days), last backup, DB / audio-cache size, card renderer, last audio problem, uptime + memory.
- **yt-dlp rot**: `start.js` self-updates yt-dlp every 3 days on boot; restart to force an update check.
- **Disk**: audio cache capped by setting `cache_max_mb` (default 600). The whole state is `data/academy.db` + `data/cookies.txt` + the Environment tab.

## Restart / recovery cheat-sheet

| Symptom | Fix |
|---|---|
| Bot offline in Discord | Panel Console: read the last lines → Restart. `Missing required env vars` → Environment tab. |
| Class has no audio | Upload fresh cookies (النظام) → end the class → start it again from the dashboard. |
| Cards are plain text | Console shows `browser: … NOT RUNNABLE` or `[card] render failed` → Restart; raise `CARD_TIMEOUT_MS` if it times out. |
| Wrong class times | `ACADEMY_TZ` missing — log shows `tz: Europe/Helsinki`. |
| Data looks empty / wrong | Restore the latest backup (النظام → ♻️). |
| Dashboard login says «محاولات كثيرة» | 5 wrong passwords in 15 min — wait it out. |
