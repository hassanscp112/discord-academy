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
    "status": "planned",            // planned | done | skipped
    "done": false,
    "session": { "id": 9, "status": "scheduled", "scheduled_at": "2026-10-07T18:00:00.000Z" }  // or null
  }],
  "sessions": [{ "id": 9, "lesson_id": 3, "lesson_title": "...", "status": "scheduled", "scheduled_at": "..." }],
  "participants": [{
    "user_id": "367669336212504576", "name": "Tello", "xp": 120,
    "level": { "xp": 100, "name": "Apprentice", "emoji": "📘" },
    "streak": 2, "lessons_done": 3, "dms_enabled": true,
    "last_activity": "2026-10-04T19:00:00.000Z"    // or null
  }],
  "quests": [{ "id": 1, "title": "...", "lesson_ids": [3,4], "ends_at": "...", "xp_reward": 150, "status": "active" }],
  "settings": { "xp_attendance": "20", "...": "...", "channel_dashboard_name": "academy-hall" },
  "overview": { "lessonsDone": 1, "lessonsTotal": 5 },
  "template": { "days": [0, 3], "time": "21:00", "daysText": "sun,wed" },  // or null
  "live": { "id": 9, "lesson_title": "...", "scheduled_at": "...", "attendees": 2 },  // or null
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

### Lessons — الدروس
| Endpoint | Body | Effect |
|---|---|---|
| `/api/dash/lesson/add` | `{ title, url, durationMin }` | add lesson at the end |
| `/api/dash/lesson/update` | `{ id, title, url, durationMin }` | edit (fields optional except id) |
| `/api/dash/lesson/remove` | `{ id }` | delete lesson + its sessions |
| `/api/dash/lesson/move` | `{ id, dir: -1 \| 1 }` | reorder up/down |

### Sessions & schedule — الحصص والجدول
| Endpoint | Body | Effect |
|---|---|---|
| `/api/dash/session/move` | `{ id, date: "YYYY-MM-DD", time: "HH:mm" }` | reschedule |
| `/api/dash/session/cancel` | `{ id }` | cancel (lesson stays) |
| `/api/dash/template` | `{ days: "sun,wed", time: "21:00" }` | weekly template |
| `/api/dash/generate` | `{}` | auto-fill sessions from template |

### Live classes — الحصص المباشرة
| Endpoint | Body | Effect |
|---|---|---|
| `/api/dash/action/start` | `{ lessonId }` | start class NOW — bot joins VC + plays audio |
| `/api/dash/action/finish` | `{}` | finish live class, pays XP |

### Quests — المهام
| Endpoint | Body | Effect |
|---|---|---|
| `/api/dash/quest/add` | `{ title, lessonIds: [3,4], ends: "2026-10-20" }` | create + announce in Discord |
| `/api/dash/quest/end` | `{ id }` | end quest |

### Settings — الإعدادات
`POST /api/dash/settings` — any of:
`tz, xp_attendance, xp_completion, xp_quest, nudge_hour, nudge_over_dm,
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
