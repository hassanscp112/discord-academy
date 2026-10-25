# 6 — Deployment & Operations Runbook

## Hosting decision (context — why things are where they are)

The owner has **zero budget / no credit card**, so only $0 options exist:
- ❌ Oracle Cloud Always Free — requires a card the owner doesn't have (runbook kept in `deploy/`).
- ❌ Free PaaS (Vercel serverless, Render/Koyeb — no UDP voice, card-gated big 3) — verdict: **no viable free cloud host exists** for a 24/7 voice bot.
- ✅ **Primary now: the owner's old Huawei MediaPad tablet** (Android, Termux) — always on, WiFi, free.
- ✅ Fallback: the owner's Windows PC (Task Scheduler job `AcademyCoach` — currently **stopped & disabled**).

## PRIMARY — tablet (Termux)

| Item | Value |
|---|---|
| Device | Huawei MediaPad, EMUI (Android) |
| App package | Termux (+ Termux:Boot) |
| LAN address | `192.168.100.87` (DHCP — may change) |
| SSH | port **8022**, key `~/.ssh/academy_phone`, user `u0_aXXX` (`ssh -p 8022 <ip>`) |
| Dashboard | `http://192.168.100.87:8420` |
| App dir | `~/discord-academy` (cloned from a git bundle) |
| Env/DB | `~/.env` copied to app dir, `~/academy.db` → `data/academy.db` |
| Supervisor | `~/.termux/boot/academy.sh`: `termux-wake-lock` + `while true; do node src/coach/index.js >> ~/coach.log; sleep 10; done` — Termux:Boot autostart at device boot, 10 s crash-restart loop |
| Binaries | `nodejs-lts`, `ffmpeg`, `yt-dlp`, `git` from Termux pkg (ffmpeg WORKS in Termux) |
| Browser for cards | Termux chromium package — card rendering works on-device (hence the serial render queue + speed work: page reuse, JPEG q88, DPR 1.5, pre-warm, inlined fonts) |

### Deploy new code to the tablet
1. Commit locally, then `git bundle create academy.bundle master` (or reuse `phone-setup/academy.bundle` process).
2. `scp -P 8022 academy.bundle u0_a…@192.168.100.87:~/`
3. On device: `cd ~/discord-academy && git pull ~/academy.bundle master && npm ci --omit=dev`
4. Restart: `pkill -f 'node src/coach'` — the supervisor loop restarts it within 10 s with the new code.
   (The `phone-setup/deploy-watcher*.sh` scripts automate wait-for-ssh + bundle + clone + supervisor-install; v1 used adb-over-USB, v2 uses WiFi/LAN.)
5. Logs: `tail -f ~/coach.log` over SSH.

**Never** import/require `src/coach/index.js` from a REPL on the device — it boots the whole bot.

### Tablet-specific gotchas (learned the hard way)
- **EMUI battery management kills Termux**: exempt Termux + Termux:Boot from battery optimization, keep the tablet plugged in.
- **Clock skew breaks TLS**: if `apt`/`pkg` returns empty or HTTPS fails with not-yet-valid errors, the tablet clock is wrong — fix date/time first (this was once misdiagnosed as a network problem).
- SSH over adb (USB) also works: `adb forward tcp:8022 tcp:8022`.
- Typing via adb into the shell is unreliable (~50% of keystrokes) — prefer scp'ing scripts and running them.
- No process substitution in the device shell; `%` in URLs breaks curl (use `-G --data-urlencode`); piped stdin gets eaten by `apt`.

## OPTION — bot-hosting.net (container host, prepared 2026-10-25, not yet tried live)

Their new panel: Node.js 24, entry file + start command, Environment tab, SFTP / file manager / GitHub
clone, `npm install` from `package.json` at boot, port in `SERVER_PORT`, optional HTTPS subdomain
`*.apps.bot-hosting.cloud`. Nodes are Hetzner Finland/Germany (datacenter IPs).

1. **Plan:** Free (256 MB RAM / 512 MB disk) is too small — the audio cache alone is ~330 MB and
   Chromium for cards needs RAM. Starter (1 GB / 5 GB) at minimum; Starter+ (2 GB / 8 GB) if cards render.
2. **Upload** the repo (GitHub clone or zip) WITHOUT `node_modules`, `data/`, `.env`.
3. **Entry file:** `scripts/start.js` (or start command `npm start`). It downloads `tools/yt-dlp`
   (latest, self-updates every 3 days) and a static `tools/ffmpeg` (with libopus) when they're not on
   PATH, then boots the Coach. Downloads never block the boot.
4. **Environment tab:** `COACH_TOKEN`, `GUILD_ID`, `DASH_PASSWORD` (12+ chars), `API_TOKEN`, `TZ`,
   `BOSS_IDS`, `TRUST_PROXY=1` if you enable the HTTPS subdomain. Don't set `PORT` — `SERVER_PORT` is used.
5. **Data:** stop the tablet bot FIRST (two bots double-post), then upload its `~/discord-academy/data/academy.db`
   (the live DB — not the PC copy) and `data/cookies.txt` into `data/`.
6. **Cookies are mandatory:** YouTube bot-checks datacenter IPs far more than the home IP. Without a fresh
   `data/cookies.txt` prefetch/live audio will fail. Expect to refresh it when classes go silent.
7. **Cards:** no Chromium in the container → cards fall back to text embeds (`card.js` returns null). Owner
   prefers cards — if it matters, try setting `BROWSER_PATH` to a Chromium you upload (system libs may be missing).
8. **Dashboard is public** on the subdomain: random session tokens (hashed in `data/dash-sessions.json`),
   5-failures-per-15-min lockout per IP + 30 global, Secure cookie over HTTPS, constant-time compares.

Unverified until the first live run: Discord voice (UDP) from their containers, Chromium availability,
whether the start command may write to `tools/` (it should — it's the app dir).

## FALLBACK — Windows PC

- Task `AcademyCoach` (register via `deploy/install-task.ps1`): at logon, hidden launcher (`coach-start.vbs` → `coach-start.cmd` → `node src/coach/index.js >> data\coach.log`), restart on crash. **`coach-start.cmd` has NO restart loop of its own — restart with `schtasks /Run /TN AcademyCoach`.**
- Currently **stopped and disabled** (the tablet is primary; don't run both — two bot instances would double-post).
- Note: `deploy/academy-coach-task.xml` has stripped backslashes in its path — broken; use the ps1 installer.

## Environment variables (`.env`, template `.env.example`)

| Var | Required | Meaning |
|---|---|---|
| `COACH_TOKEN` | ✔ | Coach bot token |
| `GUILD_ID` | ✔ | the مِداد server id |
| `DASH_PASSWORD` | ✔ | web dashboard login |
| `API_TOKEN` | ✔ | token for `/api/state` + `/api/publish` |
| `TZ` | ✔ | academy timezone (e.g. `Africa/Cairo`) — schedule fallback tz |
| `BOSS_IDS` | – | comma list; boss-only buttons + health DMs |
| `DB_PATH` | – | default `./data/academy.db` |
| `PORT` | – | dashboard port, default 8420 |
| `COACH_DISABLE_DISCORD` | – | any value = dry-run (web + engines, no Discord) |
| `COACH_MSG_INTENT` | – | `1` = join MessageContent intent for PDF drop auto-detect (must ALSO be enabled in the Discord dev portal) |
| `BROWSER_PATH` | – | explicit chromium path for cards (auto-detects Edge/Chrome/Chromium) |
| `SERVER_PORT` | – | port handed out by container hosts (bot-hosting.net); wins over `PORT` |
| `TRUST_PROXY` | – | `1` = behind the host's HTTPS proxy: login rate-limit uses the real client IP from `X-Forwarded-For` |
| `YTDLP_PATH` | – | default `tools/yt-dlp.exe` on Windows, else `tools/yt-dlp` (downloaded by `scripts/start.js`), else `yt-dlp` on PATH |
| `FFMPEG_PATH` | – | default `ffmpeg` on PATH; `scripts/start.js` sets `tools/ffmpeg` when it had to download a static build |
| `YTDLP_COOKIES` | – | override `data/cookies.txt` |
| `AUDIO_BACKEND` | – | `ffmpeg` (default) or `lavalink` — optional Lavalink node for class audio, ffmpeg is the fallback (see docs/7) |
| `LAVALINK_HOST` / `_PORT` / `_PASSWORD` / `_SECURE` | – | Lavalink v4 node (default port 2333, password `youshallnotpass`, `_SECURE=1` for wss) |
| `LAVALINK_LOCAL_FILES` | – | `1` = node is on this machine and may read `data/cache/*.opus` (needs `sources.local: true`) |
| `AI_TOKEN`, `STUDIO_PORT` (8421), `OLLAMA_URL`, `OLLAMA_MODEL`, `COACH_API_URL`, `AI_ADMIN_CHANNEL` | – | AI-admin studio only (PC) |

## Discord app configuration (dev portal)

- Coach intents: Server Members ✔; Message Content only if `COACH_MSG_INTENT=1`.
- Permissions used: Send Messages, Embed Links, Read History, Add Reactions, View Channels, Connect, Manage Roles (course/learner roles), Manage Channels (member channels), plus ManageMessages **wanted** for pinning (currently NOT held — pins silently fail).

## Monitoring & maintenance

- **Health module**: error DMs (throttled 1/h per signature) + 9 AM daily heartbeat to bosses (counts + next session + 24 h errors).
- **yt-dlp rot**: YouTube periodically blocks; if classes silently fall back to live-stream or fail, update yt-dlp (`yt-dlp -U` / reinstall). Cookies file `data/cookies.txt` (dedicated Google account export) is auto-picked-up by every spawn — mandatory on datacenter IPs, recommended everywhere.
- **Backups**: `data/academy.db` + `data/cookies.txt` + `.env` are the whole state (audio cache is disposable). The tablet DB was seeded from `academy-snapshot.db`; copy the DB off-device periodically (scp). Keep at least one copy on the PC.
- **Cache eviction**: `data/cache/*.opus` grows unbounded — safe to delete old files anytime (they re-download on demand).

## Restart / recovery cheat-sheet

| Symptom | Action |
|---|---|
| Bot offline | SSH to tablet → `tail ~/coach.log`; `pkill -f 'node src/coach'` (supervisor restarts) |
| Device rebooted | Termux:Boot should auto-start; if not: open Termux, check `~/.termux/boot/academy.sh`, run it |
| Dashboard unreachable | Check tablet WiFi IP changed (DHCP) → re-scan IP, update bookmark |
| Cards stopped rendering | `BROWSER_PATH` / chromium broken after pkg upgrade — check `coach.log` for renderer fallbacks |
| Classes silent / yt-dlp errors | Update yt-dlp; verify `data/cookies.txt` exists & fresh; check YouTube bot-block (429) |
