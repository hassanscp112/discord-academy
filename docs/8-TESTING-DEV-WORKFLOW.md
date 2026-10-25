# 8 — Testing & Dev Workflow

## Commands

```bash
npm install                # first time (Node >= 22.5 required — node:sqlite)
npm test                   # engine test suite — NO Discord tokens needed
npm run coach              # start the bot + dashboard (needs .env)
npm run studio             # optional AI admin studio (PC, needs Ollama)
COACH_DISABLE_DISCORD=1 npm run coach   # dry-run: web + API + engines, messages print to console
```

## Test suite (`scripts/test-academy.js`)

Self-contained (~100 assertions, all green as of 2026-10-14). Before importing anything it sets
`DB_PATH=./data/test-academy.db`, `TZ=UTC`, `COACH_DISABLE_DISCORD=1`, `DASH_PASSWORD=test`,
`API_TOKEN=test-token` and wipes the throwaway DB — **this env-before-import order is required**
(the DB is a singleton; see gotcha #12).

Coverage blocks:
1. Time helpers — Cairo DST correctness, weekday slot generation.
2. Cadence templates — daily / every-N-days anchoring / legacy shape / invalid rejection.
3. Lesson CRUD — ordering + compaction.
4. Schedule generation — slots, idempotency.
5. Long-video splitting — 2 h video @60-min classes → 2 parts, `offset_min`, resume offset, playlist import dedupe.
6. Multi-course — create/update/remove, last-course protection.
7. Session state machine — scheduled→live, empty-room missed-poll, 24 h auto-move, attended flow with XP/streak/finish.
8. Completion/levels/quests/nudges — idempotent XP, quest tick dedupe, nudge cooldown, roster consistency, headless member-dashboard rendering.
9. Books & groups — page clamping, auto-finish, roster order, stats.
10. Subscriptions/questions/member management — toggles, one-answer rule, rename/remove cascades, PDF metadata.
11. Publish API — stale `revision` → 409; accepted publish applies.

Run tests after ANY change to `src/core/*` or `src/coach/{sessions,memberdash,publish,web}.js`.
The suite boots the real Express app in dry-run, so web routes are exercised too.

## Dev loop (on the PC)

1. `COACH_DISABLE_DISCORD=1 npm run coach` for pure engine/web work — dashboard at
   `http://localhost:8420`, log in with `DASH_PASSWORD` from `.env`.
2. Full bot work: `npm run coach` on the PC — **but only while the tablet instance is stopped**
   (two live bots double-post to Discord). Coordinate with the owner.
3. Real Discord objects (guild/channels) are read from the live DB — for experiments use
   `DB_PATH=./data/dev.db` to get a fresh sandbox DB.
4. yt-dlp on Windows uses `tools/yt-dlp.exe`; put `data/cookies.txt` to avoid bot-blocks.

## Making changes safely (checklist)

- [ ] `npm test` green.
- [ ] New/changed user-visible strings are **Arabic** (`templates.js` or owning module).
- [ ] Interactions that render cards `deferUpdate()` first.
- [ ] New yt-dlp spawns spread `cookieArgs()` and run sequentially.
- [ ] No XP/level text surfaces reintroduced.
- [ ] Buttons follow the customId contract (`docs/4`); 2-segment ids read from `action`.
- [ ] DB changes go through `src/core/db.js` migrations (additive, try/catch) + `academy.js` function.
- [ ] Card renders go through `renderCard` (the serial queue).

## Deploy (see `docs/6` for the full runbook)

Commit → `git bundle create academy.bundle master` → scp to tablet → `git pull` + `npm ci` →
`pkill -f 'node src/coach'` (supervisor loop restarts with new code). Verify in `~/coach.log`
and the Discord hub.

## Git conventions

Single branch `master`, batch commits after features are verified live (history shows feature-batch
messages like "v5-v8 batch"). `data/`, `.env`, `*.log`, `phone-setup/` are gitignored.
Uncommitted work may exist — the owner runs parallel agent sessions; check `git status` and
never reset/discard changes you didn't make.
