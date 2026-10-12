# Dashboard API Reference — مرجع واجهة البرمجة

Everything a custom dashboard needs. Base URL: `http://localhost:8420`
(عند النشر على السيرفر السحابي: نفس المسارات على عنوان السيرفر)

## Authentication — المصادقة

**Two schemes:**

| Who | How |
|---|---|
| Browser (your dashboard) | Cookie `dash` — obtained by `POST /login` with `{ "password": "<DASH_PASSWORD from .env>" }` |
| AI studio / scripts | Header `x-api-token: <API_TOKEN from .env>` (only for `/api/state` + `/api/publish`) |

All `/api/dash/*` endpoints need the cookie. Wrong/missing cookie → `401`.

**Login flow:**
```
GET  /login                      → HTML login form (or build your own and POST to it)
POST /login   (form: password)   → sets cookie, redirects to /
GET  /logout                    → clears cookie
```

---

## Read endpoints — القراءة

### `GET /api/dash/data`
The whole state in one call. Refresh every 10–15s for a live dashboard.

```jsonc
{
  "tz": "Asia/Riyadh",
  "botOk": true,                    // is the Discord bot connected
  "lessons": [{
    "id": 3, "position": 1, "title": "الدرس الأول",
    "url": "https://youtu.be/...", "duration_min": 45,
    "video_id": "dQw4...", "video_sec": 7315,   // real video length (when known)
    "parts": 3,                                   // video longer than one class -> split into N sessions
    "status": "planned",            // planned | done | skipped
    "done": false,
    "session": { "id": 9, "status": "scheduled", "scheduled_at": "2026-10-07T18:00:00.000Z" }  // or null
  }],
  "sessions": [{ "id": 9, "lesson_id": 3, "lesson_title": "...", "status": "scheduled", "scheduled_at": "...",
    "offset_min": 45, "part": 1, "parts": 3, "from_min": 0, "to_min": 45 }],  // which slice of the video
  "participants": [{
    "user_id": "367669336212504576", "name": "Tello", "xp": 120,
    "level": { "xp": 100, "name": "Apprentice", "emoji": "📘" },
    "streak": 2, "lessons_done": 3, "dms_enabled": true,
    "last_activity": "2026-10-04T19:00:00.000Z"    // or null
  }],
  "quests": [{ "id": 1, "title": "كتاب...", "category": "book", "done": 2, "status": "active" }],
  "settings": { "xp_attendance": "20", "...": "...", "channel_dashboard_name": "academy-hall" },
  "overview": { "lessonsDone": 1, "lessonsTotal": 5 },
  "template": { "mode": "days", "days": [0, 3], "time": "21:00", "daysText": "الأحد،الأربعاء" },  // or { "mode": "daily", time } / { "mode": "interval", "everyN": 2, time }; or null
  "live": { "id": 9, "lesson_title": "...", "scheduled_at": "...", "attendees": 2,
    "part": 2, "parts": 3, "from_min": 45, "to_min": 90 },  // or null
  "nextSession": { "id": 9, "lesson_id": 3, "lesson_title": "...", "scheduled_at": "..." }  // or null
}
```

### `GET /api/dash/member/:userId`
One member's full profile + activity timeline (newest first).

```jsonc
{
  "user_id": "...", "name": "Tello", "xp": 120,
  "level": { "name": "Apprentice", "emoji": "📘" },
  "streak": 2, "lessons_done": 3, "dms_enabled": true,
  "timeline": [
    { "at": "...", "ico": "✅", "title": "أكمل درساً", "sub": "Lesson title" },
    { "at": "...", "ico": "🔊", "title": "حضر حصة", "sub": "Lesson title (45 دقيقة)" },
    { "at": "...", "ico": "🏅", "title": "أنجز مهمة", "sub": "Quest title" }
  ]
}
```

---

## Write endpoints — الكتابة

All are `POST` with JSON body. All reply `{ "ok": true, "message": "..." }` or
`4xx { "error": "..." }`. Times/dates are in the academy timezone unless an ISO string.

### Courses — الدورات (each with its own lessons + cadence)
| Endpoint | Body | Effect |
|---|---|---|
| `/api/dash/course/add` | `{ title, playlistUrl?, durationMin?, generate?, mode, days?, everyN?, time? }` | create a course; optionally import a playlist into it right away and auto-schedule |
| `/api/dash/course/update` | `{ id, title?, mode?, days?, everyN?, time? }` | rename and/or change this course's cadence (every day / every N days / specific days) |
| `/api/dash/course/generate` | `{ id }` | auto-schedule THIS course's lessons on its own cadence (long videos split into consecutive parts) |
| `/api/dash/course/remove` | `{ id }` | delete the course with all its lessons + sessions (the last course cannot be deleted) |

`mode` is `"days"` (`days`: "sun,wed" or Arabic names), `"daily"`, or `"interval"` (`everyN`: 2–30).
`GET /api/dash/data` returns `courses: [{ id, title, mode, time, everyN, daysText, lessons_total, lessons_done, upcoming, next_session }]`, and every lesson/session row carries `course_id`.

### Member checklists per course — قائمة إنجاز كل عضو
| Endpoint | Returns |
|---|---|
| `GET /api/dash/course/:id/progress` | `{ roster: [{ user_id, name, done, total, next_lesson: {id,title}, last_completed_at }] }` — every member's standing in one course, best first |
| `GET /api/dash/member/:userId` | now also `courses: [{ id, title, done, total, next, items: [{ lesson_id, position, title, done, completed_at }] }]` — the member's full per-course checklist |

Discord members see the same per-course breakdown with `/myprogress`.

### Lessons — الدروس
| Endpoint | Body | Effect |
|---|---|---|
| `/api/dash/lesson/add` | `{ title, url, durationMin, courseId? }` | add lesson to a course (default: first); reads the video's real length so long videos auto-split |
| `/api/dash/lesson/update` | `{ id, title, url, durationMin }` | edit (fields optional except id) |
| `/api/dash/lesson/remove` | `{ id }` | delete lesson + its sessions |
| `/api/dash/lesson/move` | `{ id, dir: -1 \| 1 }` | reorder within its course |
| `/api/dash/playlist/import` | `{ url, durationMin, courseId? }` | **import a YouTube playlist** into one course — every video becomes a lesson (deduped by video id, real durations, one summary announcement in Discord) |

### Sessions & schedule — الحصص والجدول
| Endpoint | Body | Effect |
|---|---|---|
| `/api/dash/session/move` | `{ id, date: "YYYY-MM-DD", time: "HH:mm" }` | reschedule |
| `/api/dash/session/cancel` | `{ id }` | cancel (lesson stays) |
| `/api/dash/template` | `{ mode, days?, everyN?, time }` | legacy — sets the FIRST course's cadence (use `/course/update` instead) |
| `/api/dash/generate` | `{}` | legacy — auto-fill for every course with a cadence (use `/course/generate` instead) |

### Live classes — الحصص المباشرة
| Endpoint | Body | Effect |
|---|---|---|
| `/api/dash/action/start` | `{ lessonId }` | start class NOW — bot joins VC + plays audio (resumes long videos where past classes stopped) |
| `/api/dash/action/finish` | `{}` | finish live class, pays XP |

### Live player — التحكم بالبث
`GET /api/dash/player` → `{ live: false }` or:
```jsonc
{ "live": true, "paused": false, "streaming": true, "title": "...", "positionSec": 2731,
  "durationSec": 7315, "volume": 1, "sessionId": 9, "lessonId": 3 }
```
`POST /api/dash/player` with `{ op }`:
| op | Extra | Effect |
|---|---|---|
| `pause` / `resume` | | silence the stream / continue from the same spot |
| `seek` | `{ delta: -10 }` | jump ±N seconds (signed) |
| `restart` | | back to 0 |
| `volume` | `{ value: 0.5 }` | 0–2, applies to the voice stream |

### Quests — قائمة الإنجاز
| Endpoint | Body | Effect |
|---|---|---|
| `/api/dash/quest/add` | `{ title, category: "book" \| "lecture" \| "course" }` | add checklist item + announce in Discord with a «أنجزتها ✅» button |
| `/api/dash/quest/end` | `{ id }` | remove item |

### Books & reading groups — الكتب ومجموعات القراءة
| Endpoint | Body | Effect |
|---|---|---|
| `/api/dash/book/add` | `{ title, totalPages }` | add a book to the academy library |
| `/api/dash/book/remove` | `{ id }` | delete the book (its groups end) |
| `/api/dash/group/add` | `{ title?, bookId }` | create a reading group + announce it in Discord with «📖 أنضم» / «📝 سجّل صفحتك» buttons |
| `/api/dash/group/end` | `{ id }` | end the group |

`GET /api/dash/data` includes `books` (with readers/avg%/finished stats) and `groups` (each with a `roster`: every member's `page/total_pages`, finished, updated_at). Members update their page from Discord — the group buttons, or `/group page <id> <page>`; `/books` shows their shelf. Page >= total marks the book finished automatically.

### Settings — الإعدادات
`POST /api/dash/settings` — any of:
`tz, xp_attendance, xp_completion, nudge_hour, nudge_over_dm,
nudge_cooldown_hours, recap_day, recap_hour, reminder_minutes_before,
missed_after_minutes, level_roles`

---

## Token API (for the AI studio / scripts) — خارج اللوحة

| Endpoint | Auth | Purpose |
|---|---|---|
| `GET /api/state` | `x-api-token` | full state for planning |
| `POST /api/publish` | `x-api-token` | apply a plan diff (lessons/template/generate/quests), optional `announce` posted to Discord |

## Building your dashboard — خطوات البناء

1. Put your files in `public/` (any structure: plain HTML, React build output, anything static)
2. Entry point = `public/index.html` — served at `/` (behind the login cookie)
3. Call the endpoints above with `fetch('/api/dash/...')`
4. Times arrive as UTC ISO — display with
   `new Intl.DateTimeFormat('ar', { timeZone: 'Asia/Riyadh', ... })`
5. Restart nothing — static files are served live from disk
