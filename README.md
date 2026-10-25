# هُدَى — Discord Academy

A complete study-academy system inside a private Arabic Discord server (مِداد): multi-course
scheduling of YouTube lessons, live voice-channel classes (the bot plays the lesson audio),
attendance, quizzes, books + PDF library, per-member private dashboard channels (rendered
image cards), and an Arabic RTL web dashboard for the owner — all user-facing text in Arabic.

**📖 Full documentation: start at [`AGENTS.md`](AGENTS.md) → [`docs/`](docs/).**
`docs/1-OVERVIEW.md` explains everything for a newcomer; `docs/7-GOTCHAS-KNOWN-BUGS.md` lists
the hard rules and known bugs.

## Quick start (development, on a PC)

```bash
npm install                  # Node >= 22.5 required (node:sqlite)
copy .env.example .env       # fill COACH_TOKEN, GUILD_ID, DASH_PASSWORD, API_TOKEN, TZ
npm test                     # engine test suite — no Discord needed
npm run coach                # bot + dashboard at http://localhost:8420
COACH_DISABLE_DISCORD=1 npm run coach   # dry-run: web + engines only
npm start                    # production entry: fetches yt-dlp/ffmpeg if missing, then boots
```

## Production

Runs 24/7 on an Android tablet under Termux (LAN dashboard), supervised by a boot script with a
10 s crash-restart loop. The Windows PC copy (`AcademyCoach` scheduled task) is the stopped
fallback; Oracle Cloud was abandoned (requires a credit card). Deploy runbook + ops
troubleshooting: `docs/6-DEPLOYMENT-OPS.md`.

## Layout

```
src/core/     domain logic (no Discord): db schema, engine, time math, Arabic templates
src/coach/    the Discord bot + voice streaming + Express web/API
src/ai-admin/ optional local Ollama planner (PC)
public/       owner dashboard SPA (static, no build step)
docs/         the documentation (1=overview … 8=workflow)
```
