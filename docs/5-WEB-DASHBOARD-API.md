# 5 — Web Dashboard & HTTP API

Two surfaces share port 8420 (`src/coach/web.js`):
1. the owner SPA «هُدَى · لوحة الأكاديمية» from `public/` (no build step, served live from disk), and
2. the JSON API.

On the tablet: `http://192.168.100.87:8420` (PC dev: `http://localhost:8420`).

Detailed request/response examples also live in the root `DASHBOARD_API.md`.

## Authentication

| Who | How |
|---|---|
| Browser | Cookie `dash` = random per-login session token (HttpOnly, SameSite=Lax, `Secure` over HTTPS, 30 d). `GET /login` form → `POST /login` with `password` = env `DASH_PASSWORD`. Tokens are stored hashed in `data/dash-sessions.json` (survive restarts); `GET /logout` revokes the token; changing `DASH_PASSWORD` revokes all. 5 failed logins / 15 min per IP (30 overall) → `429`. |
| AI studio / scripts | Header `x-api-token: <API_TOKEN>` — only `/api/state` + `/api/publish`. |

Wrong/missing auth → `401`. The SPA redirects to `/login` on 401.

## API route table (complete)

`ok(res,msg)` = `{ok:true,message}` + marks cards dirty. Write endpoints are POST JSON.
Times/dates accepted in academy-local tz unless ISO.

### Reads
| Method & path | Returns |
|---|---|
| `GET /api/dash/data` | whole SPA state: courses, lessons (+parts/video_sec/session), sessions (+part slices), participants, quests, books, groups (+rosters), questions, settings, overview, template, live, nextSession |
| `GET /api/dash/member/:id` | member profile: xp/level/streak, per-course checklists, book shelf, activity timeline |
| `GET /api/dash/course/:id/progress` | course roster — every member's standing, best first |
| `GET /api/dash/player` | live player snapshot (or `{live:false}`) |

### Courses
| Path | Body | Effect |
|---|---|---|
| `/api/dash/course/add` | `{title, playlistUrl?, durationMin?, generate?, mode, days?, everyN?, time?}` | create (+optional playlist import + auto-schedule + announce) |
| `/api/dash/course/update` | `{id, title?, mode?, days?, everyN?, time?}` | rename / change cadence |
| `/api/dash/course/generate` | `{id}` | auto-schedule this course |
| `/api/dash/course/remove` | `{id}` | delete course + lessons + sessions (last course protected; stops live stream) |
| `/api/dash/playlist/import` | `{url, durationMin?, courseId?}` | import YouTube playlist as lessons (deduped) + announce |

### Lessons & sessions
| Path | Body | Effect |
|---|---|---|
| `/api/dash/lesson/add` | `{title, url, durationMin, courseId?}` | add (reads real video length → auto-split) |
| `/api/dash/lesson/update` | `{id, title?, url?, durationMin?}` | edit |
| `/api/dash/lesson/remove` | `{id}` | delete + sessions |
| `/api/dash/lesson/move` | `{id, dir:-1\|1}` | reorder within course |
| `/api/dash/session/move` | `{id, date:"YYYY-MM-DD", time:"HH:mm"}` | reschedule (local tz) |
| `/api/dash/session/cancel` | `{id}` | cancel (stops stream if live) |
| `/api/dash/template` | `{mode, days?, everyN?, time}` | **legacy** — first course's cadence |
| `/api/dash/generate` | `{}` | **legacy** — all courses |

### Live class & player
| Path | Body/notes | Effect |
|---|---|---|
| `/api/dash/action/start` | `{lessonId}` | start class NOW (joins VC, resumes long videos where they stopped) |
| `/api/dash/action/finish` | `{}` | finish live session (XP + quiz out) |
| `POST /api/dash/player` | `{op}` | `pause` `resume` `seek{delta}` `restart` `volume{value 0–2}` |

### Quests, books, groups
| Path | Body | Effect |
|---|---|---|
| `/api/dash/quest/add` | `{title, category}` | add checklist item + Discord announce («أنجزتها ✅») |
| `/api/dash/quest/end` | `{id}` | end item |
| `/api/dash/book/add` | `{title, totalPages}` | add book + library card |
| `/api/dash/book/remove` | `{id}` | delete book (groups end, card removed) |
| `/api/dash/group/add` | `{title?, bookId}` | create group + announce («📖 أنضم» / «📝 سجّل صفحتك») |
| `/api/dash/group/end` | `{id}` | end group |

### Members & quiz (management)
| Path | Body | Effect |
|---|---|---|
| `/api/dash/member/rename` | `{id, name}` | rename participant |
| `/api/dash/member/remove` | `{id}` | wipe member from ~10 tables + delete their private channel |
| `/api/dash/question/add` | `{courseId, lessonId?, question, options[], correctIndex, xp?}` | add quiz question |
| `/api/dash/question/remove` | `{id}` | delete question |
| `/api/dash/question/send` | `{id}` | post question now to announcements (🇦–🇪 buttons) |

### Settings & token API
| Path | Effect |
|---|---|
| `POST /api/dash/settings` | whitelist only: `tz, xp_attendance, xp_completion, nudge_hour, nudge_over_dm, nudge_cooldown_hours, recap_day, recap_hour, reminder_minutes_before, missed_after_minutes, level_roles` |
| `GET /api/state` (token) | full academy state for the AI studio |
| `POST /api/publish` (token) | apply plan diff (`base_revision` → 409 on conflict), optional announce |

## SPA structure (`public/app.js`, hash router)

| Route | Page | Main calls |
|---|---|---|
| `#/overview` | live banner + player bar + countdown, start-now picker, finish | `data`, `player` (3 s poll), `action/start`, `action/finish`, `player` ops |
| `#/courses` | course cards + create form (cadence picker) | `course/add` |
| `#/course/:id` | lessons table (edit/move/delete/start), sessions (move/cancel), roster, quiz manager, course settings | `lesson/*`, `session/*`, `course/*`, `playlist/import`, `question/*`, `course/:id/progress` |
| `#/books` | books + groups + rosters | `book/*`, `group/*` |
| `#/members` | searchable member table → drawer (checklists, shelf, timeline, rename/remove) | `member/:id`, `member/rename`, `member/remove` |
| `#/quests` | checklist by category | `quest/*` |
| `#/settings` | whitelisted settings + read-only Discord wiring | `settings` |

Polling: `GET /api/dash/data` every 15 s — the renderer **skips updates while the user is typing**
in any form (this fixed a bug where the poll wiped half-typed input). Session move inputs show
local tz (no more 3 h drift).
