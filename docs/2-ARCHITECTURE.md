# 2 — Architecture (how the code is wired)

Node ≥ 22.5, ESM everywhere (`"type": "module"`). Core principle: **`src/core/academy.js` holds ALL
domain logic as pure SQLite functions with zero Discord imports** — the bot, the web API and the tests
all build on it. Discord is a surface, not a layer.

```
scripts/start.js    ── production entry: ensures yt-dlp / ffmpeg / Chrome / emoji font, then imports ↓
src/coach/index.js  ── boots everything (client, engines, web)
   ├─ src/core/*          domain logic (no Discord)
   └─ src/coach/*         Discord surfaces + Express + child processes
public/                   the owner dashboard SPA (static, served by src/coach/web.js)
scripts/                  start.js, tests, small utilities
```

---

## Module map (every file, what it is)

### src/core — domain logic (safe to import anywhere, no Discord)

| File | Purpose | Key exports |
|---|---|---|
| `config.js` | Env parsing + `validateCoachConfig` (required: COACH_TOKEN, GUILD_ID, DASH_PASSWORD unless dry-run). `tz` = `ACADEMY_TZ` › `TZ`; `port` = `SERVER_PORT` › `PORT`. | `config`, `validateCoachConfig` |
| `db.js` | SQLite schema + migrations + settings defaults. Opens WAL at `DB_PATH` (default `./data/academy.db`). **Singleton — first `getDb()` decides the DB.** `closeDb()` lets a restore swap the file live. | `getDb`, `closeDb`, `getSetting`, `setSetting`, `allSettings`, `getTemplate` |
| `academy.js` | The whole engine: courses, lessons, schedule generation, sessions, attendance, streaks, quests, books, groups, subs, quiz, member rename/remove, `memberEngagement()`, `overview()` | ~70 exported functions — see `3-DATABASE.md` |
| `time.js` | DST-safe timezone math. **All DB timestamps are UTC ISO; cadences live in local tz.** | `zonedToUtc`, `normalizeTemplate`, `nextSlots`, `fmtInTz`, `humanDuration` (Arabic) |
| `templates.js` | All announcement/DM strings, Arabic, with `{{placeholders}}`. Edit wording here. | `templates` |

### src/coach — the bot

| File | Purpose | Key exports |
|---|---|---|
| `index.js` | Entrypoint. Registers slash commands, wires every event handler, starts timers + web. **Never import from tests.** | — |
| `commands.js` | Re-export barrel for `interactions/`. | `commandDefs`, `handleCommand`, `handleButton`, `handleModal`, `handleSelect`, `handleContextMenu`, `isAdmin` |
| `interactions/defs.js` | Slash-command + context-menu definitions (Arabic descriptions). | `commandDefs` |
| `interactions/slash.js` | `/lesson` `/schedule` `/setup` `/myprogress` `/quest` `/books` `/group` `/pdf` `/optout`. | `handleCommand` |
| `interactions/buttons.js` | Every button. `customId.split(':')` → `[kind, action, idStr, slotIso]`. | `handleButton` |
| `interactions/forms.js` | Modals, select menus, the «📚 نشر في المكتبة» context menu. | `handleModal`, `handleSelect`, `handleContextMenu` |
| `interactions/shared.js` | Embed shorthand, Arabic day/status labels, `isAdmin`, the PDF publish modal. | `e`, `statusAr`, `isAdmin`, `openUploadModal` … |
| `bus.js` | Discord-vs-dry-run messaging: `postTo(settingKey, payload)`, `dm(userId, …)`, `bossDm(…)`. | `createBus(client)` |
| `sessions.js` | Session state machine run by the 20 s tick; records everyone already in the room at start; resumes audio after a restart mid-class; DMs the owner when a live class is silent 2.5 min; posts each attendee's «حضرت الحصة» card on finish. | `tick`, `startSessionNow`, `finishSession`, `proposeSlot` |
| `streamer.js` | Voice presence: joins VC, plays lesson audio via yt-dlp→ffmpeg pipe or cache. Every control op = kill + respawn ffmpeg at position X. Optional Lavalink first when `AUDIO_BACKEND=lavalink`. | `startStream`, `stopStream`, `prefetch`, `controlPlayer`, `playerState`, `isStreaming` |
| `lavalink.js` | **Optional, off** Lavalink backend (poru). Falls back to ffmpeg on any failure. See docs/7 before enabling. | `initLavalink`, `lavalinkPlay`, … |
| `ytdlp.js` | Binary paths + `cookieArgs()`. **Spawn `YTDLP`/`FFMPEG` from here; spread `cookieArgs()` in every yt-dlp call.** | `YTDLP`, `FFMPEG`, `cookieArgs` |
| `importer.js` | yt-dlp metadata reads: playlist → lesson list, single video → real duration. | `fetchPlaylist`, `fetchVideoMeta` |
| `checkins.js` | 60 s engine loop: nudges, weekly recap, health digest, daily backup, hourly cache trim. | `startEngines` |
| `health.js` | Throttled error DMs to the owner + daily heartbeat digest. | `initHealth`, `reportError`, `healthTick` |
| `maintenance.js` | Daily `VACUUM INTO` backups (7 kept, DM'd as .db.gz), validated live DB restore, cookies.txt validation, audio-cache budget (`cache_max_mb`), dashboard status. | `backupTick`, `makeBackup`, `restoreDatabase`, `saveCookies`, `pruneAudioCache`, `systemStatus` |
| `acadashboard.js` | Hub channel «📊-لوحة-الأكاديمية»: stats card (10-min throttle, shows next class), «الحصة» VC, hub ordering. | `refreshAcademyDashboard`, `ensureVoiceChannel`, `ensureHubOrder`, `ensureDashboardChannel` |
| `coursereg.js` | Course join cards + `csub/cunsub` + course roles + «متعلم» learner role. | `syncCourseCards`, `handleSubscribe`, `grantLearnerRole`, `ensureLearnerRole` |
| `memberdash.js` | Per-member private channels + 5-tab image-card board, dirty-set sweep (1/min), onboarding card, post-class summary card. | `refreshMemberDashboards`, `markMemberDirty`, `markAllMembersDirty`, `postOnboarding`, `postClassSummary`, `memberDashPayload` |
| `library.js` / `uploads.js` / `pdflib.js` | Book cards channel, mods' PDF drop zone, PDF storage in the pre-existing forum. | `syncLibrary`, `publishFromMessage`, `fetchBookPdf` … |
| `card.js` | HTML→JPEG renderer (puppeteer-core). Serial queue, one reused page, Tajawal inlined, boot warm-up. Returns `null` on failure → text fallback. | `renderCard`, `warmCardRenderer`, `memberCardHTML`, `classDoneCardHTML`, `academyCardHTML`, … |
| `web.js` | Express: SPA + `/api/dash/*` (cookie sessions) + login. Route table in `5-WEB-DASHBOARD-API.md`. | `startWeb` |
| `fonts.css` | Tajawal font-face CSS inlined into every card render. | — |

### Other directories

| Path | What |
|---|---|
| `public/` | Dashboard SPA: `index.html`, `app.js` (hash-router), `app.css`, logos. |
| `scripts/start.js` | Production entry (`npm start`). |
| `scripts/test-academy.js` | The test suite (`npm test`), no Discord needed. |
| `scripts/list-guilds.js` | Prints guild ids for `.env`. |
| `scripts/cdp-cookies.mjs` | Exports YouTube cookies from a running Edge (CDP port 9223) into Netscape `cookies.txt`. |
| `deploy/` | Where it runs (README), Windows fallback task, optional Lavalink config. |
| `data/` | `academy.db`, `cache/lesson-<id>.opus`, `backups/`, `cookies.txt`, `dash-sessions.json`. Gitignored. |
| `tools/` | `yt-dlp.exe` (Windows dev). On Linux, `start.js` downloads `yt-dlp`, `chrome/` here (gitignored). |

---

## Boot sequence

1. `scripts/start.js` (production): yt-dlp (download / 3-day self-update), ffmpeg (PATH or static build), chrome-headless-shell, Noto emoji font → then imports `index.js`.
2. `validateCoachConfig` → exit if required env missing. `getDb()` — creates/migrates schema.
3. Discord client (intents: Guilds, VoiceStates, Members; + MessageContent when `COACH_MSG_INTENT=1`).
4. `startWeb()` — Express on `SERVER_PORT`/`PORT` immediately.
5. `client.login()` → on **clientReady**: register guild slash commands → optional Lavalink init → health init → onboarding card → card warm-up → «الحصة» VC → learner role → hub order + stats card → course cards → library → upload channel → member dashboards backfill.
6. Event handlers: `interactionCreate` (dispatch + `grantLearnerRole`), `messageCreate` (PDF drop), `voiceStateUpdate` (attendance + first-timer welcome DM + private channel).
7. Timers: catch-up `tick()` then every **20 s**; `startEngines` every **60 s**.
8. Crash-proofing: `uncaughtException`/`unhandledRejection` are logged + reported to the owner; process keeps running.

## Timers

| Timer | Interval | What it drives |
|---|---|---|
| Session tick | 20 s | State machine, silent-class watch, member-dashboard sweep (60 s throttle), hub card (10-min throttle) |
| Engines | 60 s | Nudges (`nudge_hour`), recap (`recap_day`/`recap_hour`), health digest (`health_hour`), backup (`backup_hour`, default 4), cache trim (hourly at :30) |
| SPA (client) | 15 s data; 3 s player while live | Page refresh (skips while typing) |

## Session lifecycle (the 20 s tick)

```
scheduled ──T-30m──> reminded ──T0──> live ──attendees & T+duration──> done
                        │              │  │
                 prefetch audio        │  └─ 0 attendees at T+15 min ──> missed_poll ── 24 h ──> moved
                 + reminder post       └─ bot was offline past T+duration ──> missed_poll (no late "starting")
```

- **T0 start**: one-live-class guard → `starting` post → everyone already in «الحصة» recorded → `startStream` from `offset_min`.
- **live**: if nothing plays (restart mid-class), `resumeIfSilent` rejoins at the right second (retry every 2 min); silent 2.5 min → one owner DM.
- **finish**: stop stream → `finalizeSession` → `session_done` post + quiz questions → per-attendee streak/attendance + «حضرت الحصة» card in their channel.

## Audio pipeline (`streamer.js`)

- Cache: `data/cache/lesson-<id>.opus` (yt-dlp bestaudio → ffmpeg libopus 96 k 48 kHz). Trimmed to `cache_max_mb`, never a lesson scheduled within 14 days.
- Cached playback: `ffmpeg -re -ss <pos> -i cache [-c:a copy | -af volume=V]` (copy only at volume 1 — **never** `inlineVolume`).
- Uncached: yt-dlp pipe; part 2+ without cache first warms (full prefetch, ≤150 s).
- `connection.subscribe(player)` is **mandatory**.

## Card pipeline (`card.js`)

HTML (width 860, `#card`, RTL, inlined Tajawal + logo) → `setContent` (waitUntil `load` + `document.fonts.ready`, `CARD_TIMEOUT_MS` default 60 s) → element screenshot → **JPEG q88, DPR 1.5**. Serialized queue, one reused page, warm-up render at boot. Browser: `$BROWSER_PATH` → Edge → Chrome → chromium; on container hosts `start.js` provides chrome-headless-shell (`headless: 'shell'`).
