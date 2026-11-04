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
copy .env.example .env       # fill COACH_TOKEN, GUILD_ID, DASH_PASSWORD, BOSS_IDS, TZ
npm test                     # engine test suite — no Discord needed
npm run coach                # bot + dashboard at http://localhost:8420
COACH_DISABLE_DISCORD=1 npm run coach   # dry-run: web + engines only
npm start                    # production entry: fetches yt-dlp/ffmpeg if missing, then boots
```

## Production

Runs 24/7 on **bot-hosting.net** (Node 24 container, deployed from this repo's `main` branch, entry
file `scripts/start.js`, dashboard on the panel's HTTPS subdomain). Ship a change:
`git push origin master:main` → **Restart** in the panel. Backups, database restore and YouTube
cookies are handled from the dashboard (الإعدادات ← النظام). Runbook: `docs/6-DEPLOYMENT-OPS.md`.

## Layout

```
src/core/     domain logic (no Discord): db schema, engine, time math, Arabic templates
src/coach/    the Discord bot (interactions/ = slash/buttons/forms), voice, cards, web API, backups
public/       owner dashboard SPA (static, no build step)
docs/         the documentation (1=overview … 8=workflow)
```
