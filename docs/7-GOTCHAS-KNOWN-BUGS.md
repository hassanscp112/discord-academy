# 7 — Gotchas & Known Bugs (READ BEFORE CHANGING CODE)

Every item below cost real debugging time. Respect them.

## Hard rules

1. **Arabic only.** Every user-facing string must be Arabic — no English ever reaches a member. Slash-command *names* stay English (Discord requires them), but their descriptions are Arabic.
2. **Image cards over text embeds** (owner preference). When the renderer works, the card IS the message (image + buttons, no text). Text embeds are only the fallback when no browser is available.
3. **Interaction 3 s limit**: any handler that renders a card must `deferUpdate()` FIRST, then edit with the attachment.
4. **XP/levels/leaderboards are removed from all surfaces** (owner decision). `gamification.js` is a stub. XP still accrues internally (streaks, API data) — just never show it to members.
5. **Never `inlineVolume`** on audio resources — no opus encoder module is installed; volume rides the ffmpeg pipeline (`-af volume=`) by respawning ffmpeg. Pass-through `-c:a copy` only at volume 1.0.
6. **`connection.subscribe(player)` is mandatory** — without it the player "plays" into nothing and Discord hears silence.
7. **Only one live class at a time** across all courses — the tick's start branch checks and retries next tick.
8. **yt-dlp discipline**: always spread `cookieArgs()` (`data/cookies.txt`, checked at spawn time); spawn prefetches **sequentially** — parallel spawns re-trigger YouTube's bot-check; never kill the wrapper Node process mid-prefetch (orphaned pipes leave partial cache files — cleanup on non-zero exit exists, keep it).
9. **Channel name normalization**: Discord replaces spaces with dashes in channel names — always match the dashed form (e.g. `📚-المكتبة`). When searching by name, filter `GuildText` (forums/announcement channels are different types).
10. **Self-granted overwrites**: the bot can only grant channel overwrites for permissions IT holds itself. Channels created with explicit overwrites don't inherit the category's bot-allow — `memberdash.ensureBotOverwrite` repairs this; keep it.
11. **2-segment customIds** (`kind:id`) put the id in `action`, not `idStr` — `handleButton` destructures `[kind, action, idStr, slotIso]`. `mview`, `mcomplete`, `bkpage`, `csub`, `sub` are 2-segment. `complete` is 2-segment too. Getting this wrong = `NaN` ids (this was bug #1, fixed 2026-10-25).
12. **Never import `src/coach/index.js`** from scripts/tests — importing it boots the whole bot (login, timers, web). Import the specific module instead, and set env vars (`DB_PATH`, `TZ`, `COACH_DISABLE_DISCORD`, `DASH_PASSWORD`, `API_TOKEN`) BEFORE any import: the DB is a singleton initialized on first `getDb()`.
13. **Card renders are serialized** (queue in `card.js`) — the tablet's chromium dies on parallel renders. One page is reused; don't bypass the queue.
14. **Discord attachment URLs expire** — never store/share an attachment URL; re-fetch the message (`pdflib.fetchBookPdf`). Pinning silently fails (bot lacks ManageMessages) — don't rely on pins except where already known-working (bot-pinned messages in channels it manages).
15. **One working tree, parallel agent sessions**: the owner runs multiple AI sessions on the same checkout — re-read a file right before editing it; expect unrelated uncommitted changes.
16. **`node:sqlite`, not better-sqlite3** (and no `davey`/`dysnomia` in package.json — they broke ARM/Android installs; dysnomia is only used via the vendored `.cjs` in `src/videobot/`).
17. **DB timestamps are UTC ISO**; cadence HH:mm are local-tz. Time math must go through `core/time.js` (`zonedToUtc` handles DST). Missing tz setting once made times fall back to UTC — fallback chain is `getSetting('tz') || config.tz`.
18. **New member flow**: first voice join = welcome DM + private channel creation; ANY interaction = `متعلم` role. Don't add friction to either.

## Lavalink backend notes (tested 2026-10-25, Lavalink 4.2.2 + youtube-plugin 1.18.2)

`AUDIO_BACKEND=lavalink` is wired and falls back to ffmpeg safely, but it is **not recommended to enable** yet:

- **YouTube needs login on the node.** `/loadtracks` resolves lesson URLs, but playback fails with «This video requires login» / «No supported audio streams». yt-dlp's `data/cookies.txt` does NOT apply — the youtube-source plugin needs its own OAuth refresh token or poToken.
- **Local `.opus` cache can't start mid-file.** Starting `data/cache/lesson-<id>.opus` at a position failed 8/8 (`NullPointerException … opusPacketRouter is null`, lavaplayer 2.2.6). `trackIdentifiers` therefore only offers the cache file for parts starting at 0; parts 2+ go to the URL (→ ffmpeg fallback while YouTube is blocked).
- **Unverified:** real Discord voice output through Lavalink (the tests used a simulated gateway), and seeking inside a playing local file.
- **Hosting:** the node is a Java 17+ process (~400 MB RAM) that must run 24/7 beside the bot — heavy for the tablet.

## Known bugs (verified in code, 2026-10-14; #1 and #2 fixed 2026-10-25)

| # | Bug | Where | Impact / fix sketch |
|---|---|---|---|
| 3 | `scripts/setup-server.js` imports `buildDashboardEmbed` which no longer exists (dashboard.js stubbed). | `scripts/setup-server.js:8` | Script crashes at import. Legacy — delete or rewrite if ever needed. |
| 4 | `deploy/academy-coach-task.xml` contains a path with stripped backslashes. | `deploy/academy-coach-task.xml` | Unusable; use `deploy/install-task.ps1`. |
| 5 | VideoBot sidecar doesn't pass `--cookies` (no `cookieArgs()`) and the sidecar itself is dormant (only `/stop` is called). | `src/videobot/videobot.cjs` | If the video-screenshare feature is ever revived: add cookies + expect YouTube bot-block on fresh IPs. |

## Historical incidents (so they're never re-debugged)

- **«I finished» button + leftover English (fixed 2026-10-25)**: `complete:<lessonId>` read its id from `idStr` (→ `NaN`) and replied with undefined `xp`/`lvl`; now reads `action`, replies in Arabic, no XP. Same pass Arabized all slash-command descriptions, `/lesson` `/schedule` `/setup` `/myprogress` `/quest` `/optout` replies, missed-poll buttons, the weekly recap (no more `+XP`), the boss falling-behind DM and the generic interaction-error reply. Role colors: discord.js 14.27 takes `colors: { primaryColor }` (an object, not an array, and not the deprecated `color`).

- **Silent uncached classes (2026-10-09)**: yt-dlp 429 + bot-check on the home IP (triggered by a burst of parallel spawns during boot catch-up). Transient (~15 min). Standing fix: `data/cookies.txt` auto-used by all spawns + sequential prefetches.
- **Cadence times 21:30→00:30 drift**: scheduling fell back to UTC when no `tz` settings row existed. Fix: fallback to config tz (commit `c1ac9b2`).
- **15 s dashboard poll wiping forms**: SPA re-rendered mid-typing. Fix: skip refresh while a form input is focused/changed (commit `2baf727`).
- **Tablet "no network"**: wrong device clock → TLS not-yet-valid → apt silently empty. Fix the clock, not the network.
- **Concurrent card renders choking the tablet**: renders now serialized (commit `e778dd2`).
