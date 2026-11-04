# AGENTS.md — read this FIRST, then only what the task needs

**هُدَى (Huda) / Discord Academy** — a 24/7 study-academy Discord bot for a private Arabic server (مِداد): multi-course scheduling of YouTube lessons, voice-channel classes where the bot plays the lesson audio, attendance, quizzes, books/PDF library, per-member private dashboard channels (rendered image cards), and an Arabic RTL web dashboard for the owner. Runs on Node ≥ 22.5 (ESM, `node:sqlite`, discord.js v14, Express, puppeteer-core, yt-dlp+ffmpeg child procs). **Hosted on bot-hosting.net** (Node 24 container, deployed from GitHub `hassanscp112/discord-academy` `main`, dashboard at its `*.apps.bot-hosting.cloud` HTTPS address).

**Full documentation: [`docs/`](docs/) — read ONE file, not the whole repo:**

| Task | Read |
|---|---|
| What is this / features / glossary | `docs/1-OVERVIEW.md` |
| How code is wired / module map / timers / lifecycle | `docs/2-ARCHITECTURE.md` |
| DB schema / settings keys / academy.js API | `docs/3-DATABASE.md` |
| Channels / roles / slash commands / buttons / cards | `docs/4-DISCORD-SURFACES.md` |
| Dashboard SPA / HTTP API routes | `docs/5-WEB-DASHBOARD-API.md` (+ root `DASHBOARD_API.md`) |
| Hosting / deploy / env vars / backups / ops | `docs/6-DEPLOYMENT-OPS.md` |
| **Hard rules & known bugs** | `docs/7-GOTCHAS-KNOWN-BUGS.md` |
| Tests / dev workflow / change checklist | `docs/8-TESTING-DEV-WORKFLOW.md` |

File-by-file map with key exports is in `docs/2-ARCHITECTURE.md` — use it to jump straight to the
relevant source file instead of scanning the tree.

## Commands

```bash
npm test                                   # engine + handler suite, no Discord needed — run after any change
npm run coach                              # bot + dashboard :8420 (needs .env)
COACH_DISABLE_DISCORD=1 npm run coach      # dry-run (web + engines, no Discord)
npm start                                  # production entry (scripts/start.js): fetches yt-dlp / ffmpeg / Chrome if missing
```
Deploy = commit → `git push origin master:main` → **Restart** in the bot-hosting.net panel (it pulls `main`
first). Full runbook: `docs/6-DEPLOYMENT-OPS.md`.

## Non-negotiable rules (details & why in docs/7)

1. **All user-facing text in Arabic** — no English ever reaches a member (slash command *names* excepted).
2. **Image cards, not text embeds** (owner preference); `deferUpdate()` before any card render.
3. **XP/levels/leaderboards are removed** — never reintroduce them (or "points") to any surface.
4. Voice: **never `inlineVolume`** (no opus encoder — volume via ffmpeg `-af`); **`connection.subscribe(player)` is mandatory**.
5. **One live class at a time** (guard exists in the tick — keep it).
6. yt-dlp: always spread `cookieArgs()`; spawn `YTDLP`/`FFMPEG` from `ytdlp.js`, never a literal path; **spawn sequentially**.
7. Channel names normalize **spaces→dashes**; match `GuildText`, not forums.
8. `handleButton` splits customId as `[kind, action, idStr, slotIso]` — **2-segment ids put the id in `action`** (`complete:`, `mview:`, `mcomplete:`, `bkpage:`, `sub:`, `csub:`…).
9. **Never import `src/coach/index.js`** from tests (it boots the bot); set env BEFORE importing modules (DB singleton). `scripts/start.js` is the one script meant to boot it.
10. Card renders go through the **serial queue** in `card.js`; edits that replace an image pass `attachments: []`.
11. Discord **attachment URLs expire** — re-fetch, never store URLs.
12. DB timestamps are UTC ISO; cadence times are local tz (`ACADEMY_TZ` > `TZ`) — all math via `src/core/time.js`.
13. Domain changes go in `src/core/academy.js` (pure SQLite, no Discord); Discord is a surface.
14. The owner may run **parallel agent sessions on this tree** — re-read files right before editing; never discard others' uncommitted work.
15. Tests must never touch real data: the suite isolates `DB_PATH`, `AUDIO_CACHE_DIR`, `BACKUP_DIR`, `YTDLP_COOKIES`.

## Repo map (10-second version)

```
src/core/      domain logic: db.js (schema+migrations), academy.js (engine), time.js, templates.js (Arabic strings), config.js
src/coach/     the bot: index.js (entry), commands.js → interactions/ (defs, slash, buttons, forms, shared),
               sessions.js (20s tick), streamer.js (voice+ffmpeg), lavalink.js (optional, off),
               memberdash.js, coursereg.js, acadashboard.js, library.js, uploads.js, pdflib.js,
               card.js (HTML→JPEG), web.js (Express+API), maintenance.js (backups/restore/cookies/cache),
               checkins.js, health.js, bus.js, ytdlp.js, importer.js
public/        owner dashboard SPA (no build step)
scripts/       start.js (production entry), test-academy.js (npm test), list-guilds.js, cdp-cookies.mjs
data/          academy.db, cache/*.opus, backups/, cookies.txt, dash-sessions.json   (gitignored)
tools/         yt-dlp.exe (Windows dev); Linux yt-dlp / Chrome land here at boot   (downloads gitignored)
deploy/        README (where it runs) + install-task.ps1 (Windows fallback) + lavalink/
docs/          THE documentation (this file is the index)
```
