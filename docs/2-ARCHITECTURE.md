# 2 — Architecture (how the code is wired)

Node ≥ 22.5, ESM everywhere (`"type": "module"`), except the videobot sidecar (`.cjs`).
Core principle: **`src/core/academy.js` holds ALL domain logic as pure SQLite functions with zero
Discord imports** — the Coach bot, the web API, and tests all build on it. Discord is a surface,
not a layer.

```
src/coach/index.js  ── boots everything (client, engines, web)
   │
   ├─ src/core/*          domain logic (no Discord)
   ├─ src/coach/*         Discord surfaces + Express + child processes
   └─ src/videobot/*      experimental video-screenshare sidecar (.cjs, separate process)

public/                   the dashboard SPA (static, served by src/coach/web.js)
src/ai-admin/*            optional local Ollama planner (talks to Coach HTTP API)
scripts/                  tests + small utilities
```

---

## Module map (every file, what it is)

### src/core — domain logic (safe to import anywhere, no Discord)

| File | Purpose | Key exports |
|---|---|---|
| `config.js` | Env parsing + `validateCoachConfig` (required: COACH_TOKEN, GUILD_ID, DASH_PASSWORD, API_TOKEN unless dry-run) | `config`, `validateCoachConfig` |
| `db.js` | SQLite schema + v1→v10 migrations + settings defaults. Opens WAL, `DB_PATH` (default `./data/academy.db`). **Singleton — first import with env vars set decides the DB.** | `getDb`, `getSetting`, `setSetting`, `allSettings`, `getLevels`, `getTemplate` |
| `academy.js` (778 lns) | The whole engine: courses, lessons, schedule generation, sessions, attendance, XP/streaks, quests, books, groups, subs, quiz, member rename/remove, `overview()` | ~70 exported functions — see `3-DATABASE.md` per table |
| `time.js` | DST-safe timezone math. **All DB timestamps are UTC ISO; cadences live in local tz.** | `zonedToUtc`, `normalizeTemplate`, `nextSlots`, `fmtInTz`, `humanDuration` (Arabic) |
| `templates.js` | ALL coach message strings, Arabic, with `{{placeholders}}`. Edit wording here. | `templates` object |

### src/coach — the bot

| File | Purpose | Key exports |
|---|---|---|
| `index.js` | Entrypoint. Registers slash commands, wires every event handler, starts timers + web. **Never import this from scripts/tests — importing it boots the whole bot.** | — |
| `bus.js` | Discord-vs-dry-run messaging abstraction: `postTo(settingKey, payload)`, `dm(userId, …)`, `bossDm(…)` | `createBus(client)` |
| `commands.js` (568 lns) | Slash-command defs + the single dispatch for every button/modal/select/context-menu interaction. `customId.split(':')` → `[kind, action, idStr, slotIso]` | `commandDefs`, `handleCommand`, `handleButton`, `handleModal`, `handleSelect`, `handleContextMenu`, `isAdmin` |
| `sessions.js` (235 lns) | Session state machine run by the 20 s tick. | `tick`, `startSessionNow`, `finishSession`, `proposeSlot` |
| `streamer.js` (247 lns) | Voice presence: joins VC, plays lesson audio via yt-dlp→ffmpeg pipe or cache. Every control op = kill + respawn ffmpeg at position X. | `startStream`, `stopStream`, `prefetch`, `controlPlayer`, `playerState`, `isStreaming` |
| `lavalink.js` | **Optional** Lavalink audio backend (poru client, the approach of github.com/faisaljs/Groove-Music). Only active with `AUDIO_BACKEND=lavalink` + `LAVALINK_HOST`; `streamer.js` tries it first and falls back to ffmpeg on any failure, including mid-class. | `initLavalink`, `lavalinkPlay`, `lavalinkUpdate`, `lavalinkStop`, `onLavalinkFailure` |
| `ytdlp.js` | `cookieArgs()` → `['--cookies','data/cookies.txt']` if the file exists. **Every yt-dlp spawn must spread this.** Also the binary paths: `YTDLP` (`$YTDLP_PATH` → `tools/yt-dlp(.exe)` → PATH) and `FFMPEG` (`$FFMPEG_PATH` → PATH) — spawn these, never a literal `'ffmpeg'`. | `cookieArgs`, `YTDLP`, `FFMPEG` |
| `importer.js` | yt-dlp metadata reads: playlist → lesson list, single video → real duration | `fetchPlaylist`, `fetchVideoMeta` |
| `checkins.js` | 60 s engine loop: daily nudges (18:00), weekly recap (Sun 21:00), health tick (9:00) | `startEngines` |
| `health.js` | Throttled error DMs to boss + daily heartbeat digest | `initHealth`, `reportError`, `healthTick` |
| `acadashboard.js` | Hub channel «📊-لوحة-الأكاديمية»: creates it, live stats card (10-min throttle), «الحصة» VC, one-time hub ordering | `refreshAcademyDashboard`, `ensureVoiceChannel`, `ensureHubOrder`, `removeLegacyDashboard` |
| `coursereg.js` | Course join cards in the hub + `csub/cunsub` handling + course roles + «متعلم» learner role (granted on every interaction) | `syncCourseCards`, `handleSubscribe`, `grantLearnerRole`, `ensureLearnerRole`, `learnerPing` |
| `memberdash.js` (481 lns) | Per-member private channels + 5-tab image-card dashboard, dirty-set refresh sweep (1/min), pinned onboarding card | `refreshMemberDashboards`, `markMemberDirty`, `markAllMembersDirty`, `postOnboarding`, `buildMemberView` |
| `library.js` | «📚-المكتبة»: one rendered card per book, boot-time self-healing sync | `publishBook`, `unpublishBook`, `syncLibrary` |
| `uploads.js` | «📥-رفع-الكتب»: mods drop PDFs → completion panel button → shared publish pipeline (needs Message Content intent) | `onUploadMessage`, `ensureUploadChannel`, `postUploadInstructions`, `publishFromMessage` |
| `pdflib.js` | PDF storage as genre-tagged threads in the pre-existing forum «📚〡المكتبة・الشرعية»; fresh re-fetch on download | `postBookPdf`, `fetchBookPdf`, `deletePdfThread`, `findForum` |
| `card.js` (237 lns) | HTML→JPEG card renderer (puppeteer-core + system Edge/Chromium). Serial queue, page reuse, Tajawal inlined, logo as data-URI. Returns `null` on failure → callers fall back to text embeds. | `renderCard`, `warmCardRenderer`, `memberCardHTML`, `bookCardHTML`, `onboardingCardHTML`, `listCardHTML`, `academyCardHTML` |
| `web.js` (529 lns) | Express: SPA + `/api/dash/*` (cookie) + `/api/state`,`/api/publish` (token) + login. Full route table in `5-WEB-DASHBOARD-API.md`. | `startWeb` |
| `publish.js` | Applies an AI-studio plan diff with optimistic concurrency (`revision` setting) | `applyPublish`, `currentRevision` |
| `dashboard.js` | **Stub** (old text dashboard retired). No-op `refreshDashboard`/`markDashboardDirty` kept so imports don't break. | — |
| `gamification.js` | **Stub** — XP ranks/announcements removed by owner decision. | — |
| `fonts.css` | Tajawal font-face CSS (107 KB, inlined into every card render — zero network) | — |

### src/ai-admin — optional local planner (PC only)

| File | Purpose |
|---|---|
| `index.js` | Studio + optional boss-only Discord chat. Pulls state from Coach `GET /api/state`. |
| `ollama.js` | Thin client for local Ollama `/api/chat` (tool-calling). |
| `planner.js` | Draft model: local mutable draft + LLM tools (add/remove/move lesson, set template, …) + `publish()` → `POST /api/publish`. Flat lesson list — predates multi-course; course-aware edits belong in the SPA. |
| `studio.js` | Single-file localhost chat UI on 8421. |

### Other directories

| Path | What |
|---|---|
| `public/` | Dashboard SPA: `index.html`, `app.js` (848 lns, hash-router), `app.css`, `logo*.png` (the هُدَى emblem), `shot-user.png`. |
| `scripts/start.js` | Production entry for container hosts (`npm start`): fetches Linux `tools/yt-dlp` + static `tools/ffmpeg` when missing, then imports `src/coach/index.js` in-process. The one script that is *meant* to boot the bot. |
| `scripts/test-academy.js` | The test suite (`npm test`) — 328 lines, no Discord needed. |
| `scripts/list-guilds.js` | Helper: prints guild ids for `.env`. |
| `scripts/setup-server.js` | **Legacy & broken** (imports a removed export) — do not use. |
| `src/videobot/` | Experimental video screenshare sidecar: `videobot.cjs` (control API on 8422, yt-dlp → ffmpeg H264 → RTP) + `VideoVoiceConnection.cjs` (1477-ln vendored dysnomia fork adding video SSRC / op-12 publish / DAVE video encryption). Dormant: only `/stop` is called. |
| `deploy/` | Oracle Cloud runbook (abandoned — needs a credit card), Windows scheduled-task files for the PC fallback. |
| `phone-setup/` | Tablet (Termux) bootstrap + deploy watcher scripts + adb tools + git bundle. Gitignored. |
| `data/` | `academy.db` (SQLite, WAL), `cache/lesson-<id>.opus` audio cache, `cookies.txt` (yt-dlp cookies). Gitignored. |
| `tools/` | `yt-dlp.exe` (Windows dev). Linux/tablet uses PATH yt-dlp; override with `YTDLP_PATH`. |

---

## Boot sequence (`src/coach/index.js`)

1. `validateCoachConfig` → exit if required env missing.
2. `getDb()` — creates/migrates schema, seeds default settings, creates the first course if none.
3. Build Discord client (intents: Guilds, VoiceStates, Members; + MessageContent only when `COACH_MSG_INTENT=1`).
4. `startWeb()` — Express on `PORT` (8420) immediately (dashboard works even while Discord connects).
5. `client.login()` → on **ready**: register guild slash commands → `ensureLevelRoles` (stub) → health init (`bossDm`) → `postOnboarding` (pinned guide) → `warmCardRenderer` → `ensureVoiceChannel` («الحصة») → `ensureLearnerRole` → `removeLegacyDashboard` → `ensureHubOrder` (one-time) → `refreshAcademyDashboard` (stats card) → `syncCourseCards` → `syncLibrary` → `ensureUploadChannel` + `postUploadInstructions` → `markAllMembersDirty` + `refreshMemberDashboards` (backfill private channels).
6. Event handlers: `interactionCreate` (dispatch + `grantLearnerRole` on EVERY interaction), `messageCreate` (PDF drop detect), `voiceStateUpdate` (attendance + welcome DM + first-timer private channel).
7. Timers start: initial catch-up `tick()` then every **20 s**; `startEngines` loop every **60 s**.
8. Crash-proofing: `uncaughtException`/`unhandledRejection` are logged + reported to boss, process keeps running.

## Timers inside the Coach

| Timer | Interval | What it drives |
|---|---|---|
| Session tick | 20 s (`sessions.tick`) | The whole session state machine + member-dashboard dirty sweep (inner 60 s throttle) |
| Engines | 60 s (`checkins.startEngines`) | Nudges at `nudge_hour` (once/day, `nudge_last_run` guard), recap at `recap_day`/`recap_hour`, health digest at `health_hour` |
| Hub stats card | on events, throttled 10 min | `refreshAcademyDashboard` |
| SPA (client-side) | 15 s `/api/dash/data`; 3 s `/api/dash/player` while live | Page refresh (skips while user is typing in a form) |

## Session lifecycle (the 20 s tick)

```
scheduled ──T-30m──> reminded ──T0──> live ──attendees & T+duration──> done
                        │                 │
                 prefetch audio      0 attendees at T+15min
                 + reminder post          │
                                          v
                                    missed_poll (buttons: move/slots/skip)
                                          │ no answer within 24 h
                                          v
                                    session moved to proposed slot
```

- **T0 start**: single-live-class guard (never two live classes) → post `starting` (ping = course role → subscriber mentions → `ping_role`) → `startStream` joins «الحصة» and plays from `offset_min`.
- **finish**: stop stream → `finalizeSession` (close attendance rows, session `done`; lesson `done` when no sessions remain) → post `session_done` → post every lesson quiz question → pay attendance XP + streak bonus → refresh cards.
- All state lives in the `sessions` table (`status`, `live_post_id`, `proposed_at`, `poll_at`, `offset_min`).

## Audio pipeline (`streamer.js`)

- Cache file: `data/cache/lesson-<id>.opus` (yt-dlp bestaudio → ffmpeg libopus 96 k 48 kHz stereo).
- Cached playback: `ffmpeg -re -ss <pos> -i cache [-c:a copy | -af volume=V]` (copy only at volume 1 — no opus encoder module, so **never** `inlineVolume`).
- Uncached: yt-dlp pipe (`--download-sections *{pos}-inf` when resuming); part 2+ without cache first *warms* (full prefetch, up to 150 s) because the live-section pipe is slow/unreliable.
- `connection.subscribe(player)` is **mandatory** — without it Discord hears silence.
- Optional `AUDIO_BACKEND=lavalink`: `startStream` first asks `lavalink.js` to play (position + `endTime` = part boundary in one PATCH; pause/seek/volume are PATCHes, no respawn). Any refusal → the ffmpeg path above. A node disconnect or track error mid-class → `onLavalinkFailure` rejoins via `@discordjs/voice` and continues from the same second. `playerState()` reports `backend`.
- Player controls = respawn ffmpeg at the target second. Position = baseSec + wall-clock elapsed.

## Card pipeline (`card.js`)

HTML template (width 860, `id="card"` element, RTL, Tajawal from inlined `fonts.css`, logo base64) → `page.setContent` (networkidle0, 15 s) → screenshot element → **JPEG q88, DPR 1.5** → sent as attachment. Renders are **serialized through a queue** (the tablet's chromium can't parallelize) and reuse one page. Any failure → `null` → caller falls back to a plain text embed. Browser candidates: `$BROWSER_PATH` → Edge → Chrome → chromium/chromium-browser/google-chrome.

## Publish flow (AI studio)

`studio chat` → planner mutates local draft via LLM tool calls → `publish()` → `POST /api/publish` (x-api-token, `base_revision` for optimistic concurrency → 409 on stale) → `applyPublish` writes template/lessons/sessions/quests → optional announce posted to Discord.
