# AGENTS.md — read this FIRST, then only what the task needs

**هُدَى (Huda) / Discord Academy** — a 24/7 study-academy Discord bot for a private Arabic server (مِداد): multi-course scheduling of YouTube lessons, voice-channel classes where the bot plays the lesson audio, attendance, quizzes, books/PDF library, per-member private dashboard channels (rendered image cards), and an Arabic RTL web dashboard for the owner. Runs on Node ≥ 22.5 (ESM, `node:sqlite`, discord.js v14, Express, puppeteer-core, yt-dlp+ffmpeg child procs). Hosted on an Android tablet via Termux (LAN 192.168.100.87:8420).

**Full documentation: [`docs/`](docs/) — read ONE file, not the whole repo:**

| Task | Read |
|---|---|
| What is this / features / glossary | `docs/1-OVERVIEW.md` |
| How code is wired / module map / timers / lifecycle | `docs/2-ARCHITECTURE.md` |
| DB schema / settings keys / academy.js API | `docs/3-DATABASE.md` |
| Channels / roles / slash commands / buttons / cards | `docs/4-DISCORD-SURFACES.md` |
| Dashboard SPA / HTTP API routes | `docs/5-WEB-DASHBOARD-API.md` (+ root `DASHBOARD_API.md`) |
| Hosting / tablet deploy / env vars / ops | `docs/6-DEPLOYMENT-OPS.md` |
| **Hard rules & known bugs** | `docs/7-GOTCHAS-KNOWN-BUGS.md` |
| Tests / dev workflow / change checklist | `docs/8-TESTING-DEV-WORKFLOW.md` |

File-by-file map with key exports/line anchors is in `docs/2-ARCHITECTURE.md` — use it to jump
straight to the relevant source file instead of scanning the tree.

## Commands

```bash
npm test                                   # engine suite, no tokens needed — run after core changes
npm run coach                              # bot + dashboard :8420 (needs .env)
COACH_DISABLE_DISCORD=1 npm run coach      # dry-run (web + engines, no Discord)
```
Deploy to the tablet = git bundle → scp → `git pull && npm ci` → `pkill -f 'node src/coach'`
(supervisor restarts it). Full runbook: `docs/6-DEPLOYMENT-OPS.md`.

## Non-negotiable rules (details & why in docs/7)

1. **All user-facing text in Arabic** — no English ever reaches a member.
2. **Image cards, not text embeds** (owner preference); `deferUpdate()` before any card render.
3. **XP/levels/leaderboards are removed** — never reintroduce them to any surface.
4. Voice: **never `inlineVolume`** (no opus encoder — volume via ffmpeg `-af`); **`connection.subscribe(player)` is mandatory**.
5. **One live class at a time** (guard exists in the tick — keep it).
6. yt-dlp: always spread `cookieArgs()` (`data/cookies.txt`); **spawn sequentially**; don't kill mid-prefetch.
7. Channel names normalize **spaces→dashes**; match `GuildText`, not forums.
8. `handleButton` splits customId as `[kind, action, idStr, slotIso]` — **2-segment ids put the id in `action`** (`mview:`, `mcomplete:`, `complete:`, `bkpage:`, `sub:`, `csub:`…).
9. **Never import `src/coach/index.js`** from tests/scripts (it boots the whole bot); set env BEFORE importing modules (DB singleton).
10. Card renders go through the **serial queue** in `card.js` (tablet chromium can't parallelize).
11. Discord **attachment URLs expire** — re-fetch, never store URLs.
12. DB timestamps are UTC ISO; cadence times are local tz — all math via `src/core/time.js`.
13. Domain changes go in `src/core/academy.js` (pure SQLite, no Discord); Discord is a surface.
14. The owner runs **parallel agent sessions on this tree** — re-read files right before editing; never discard others' uncommitted work.
15. Before fixing anything, check the known bugs in docs/7 (the «I finished» `complete:` button was fixed 2026-10-25 — it is 2-segment, id in `action`).

## Repo map (10-second version)

```
src/core/      domain logic: db.js (schema+migrations), academy.js (engine), time.js, templates.js (Arabic strings), config.js
src/coach/     the bot: index.js (entry), commands.js (all interactions), sessions.js (20s tick),
               streamer.js (voice+ffmpeg), memberdash.js, coursereg.js, acadashboard.js, library.js,
               uploads.js, pdflib.js, card.js (HTML→PNG), web.js (Express+API), checkins.js, health.js, bus.js
src/ai-admin/  optional local Ollama planner (PC)
src/videobot/  dormant video-screenshare sidecar (dysnomia fork, .cjs)
public/        dashboard SPA (no build step)
scripts/       test-academy.js (npm test), list-guilds.js  [setup-server.js is BROKEN/legacy]
data/          academy.db + cache/*.opus + cookies.txt        (gitignored)
deploy/        Oracle runbook (abandoned) + Windows task files
phone-setup/   tablet bootstrap + deploy watchers             (gitignored)
docs/          THE documentation (this file is the index)
```
