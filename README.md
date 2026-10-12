# Discord Academy

Two-bot study-group system for Discord:

- **Academy Coach** (cloud VM, 24/7) — lessons, schedule, session reminders,
  voice-channel attendance, missed-class auto-reschedule, check-in nudges,
  XP/levels/quests, live dashboard embed, web dashboard + private API.
- **AI Admin** (your PC) — local planning studio with direct Ollama: chat in
  "coach mode" to restructure the course, then **Publish** pushes the plan to
  the Coach's API. Optionally also answers you in a private Discord channel.

## Quick start (development, on your PC)

```bash
npm install
copy .env.example .env      # fill in tokens (see below)
npm run coach               # Coach: dashboard on http://localhost:8420
npm run studio              # AI Admin studio on http://localhost:8421
npm test                    # engine test suite (no Discord needed)
```

Dry-run mode without Discord tokens: set `COACH_DISABLE_DISCORD=1` and start
the Coach — web dashboard, API, and the full session engine run against the DB
while messages print to the console.

## Discord setup (server-owner account!)

1. Go to <https://discord.com/developers/applications> → **New Application**
   → name it e.g. `Academy Coach`. Repeat for `AI Admin`.
2. In each app: **Bot** tab → *Reset Token* → copy into `.env`
   (`COACH_TOKEN`, `AI_TOKEN`).
3. Privileged intents (**Bot** tab, both apps):
   - Coach: **Server Members Intent** ON
   - AI Admin: **Message Content Intent** ON
4. Invite links (**OAuth2 → URL Generator**): check `bot` +
   - Coach scopes/permissions: `Send Messages`, `Embed Links`, `Read Message
     History`, `Add Reactions`, `View Channels`, `Connect`, `Manage Roles`
     (for level roles), `Manage Channels` (creates each member's private
     progress channel)
   - AI Admin: `Send Messages`, `Read Message History`, `View Channels`
   - Open the generated URL, pick your server. Bots land at the bottom of the
     member list — drag roles as you like.
5. In Discord: enable Developer Mode (Settings → Advanced), right-click your
   server → *Copy Server ID* → `GUILD_ID`. Right-click yourself → *Copy User
   ID* → `BOSS_IDS`.

## First run in the server

```
/setup dashboard:#academy-hall study_vc:🔊-study-room ping_role:@Students
/lesson add title:"Lesson 1 — Intro" url:<youtube link>
/schedule template days:sun,wed time:20:00
/schedule generate
```

The dashboard embed appears in the dashboard channel and updates itself.

## AI Admin (Ollama)

1. Install Ollama (<https://ollama.com>), set models dir to E:
   ```bat
   setx OLLAMA_MODELS "E:\Ollama\models"
   ollama pull qwen2.5:7b
   ```
2. `npm run studio` → open <http://localhost:8421>
3. Chat: *"restructure into 3 lessons/week, sun+wed 20:00, add a quest for
   lessons 1–2"* → review the draft → **Publish**.

## Production (Oracle Cloud Free VM)

Deployed with systemd + Caddy (HTTPS) — see `deploy/` (created during the
deploy step). The Coach runs as `academy.service`; the dashboard/API sit behind
a password and your domain.

## Project layout

```
src/core/       shared: config, sqlite schema, templates (edit wording here!), time
src/coach/      the cloud bot: commands, session engine, check-ins, gamification,
                dashboard embed, web dashboard + API, publish-apply
src/ai-admin/   the PC app: ollama client, draft planner + tools, studio UI
scripts/        test suite (npm test)
```
