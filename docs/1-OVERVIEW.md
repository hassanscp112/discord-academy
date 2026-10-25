# 1 — Project Overview (read this to understand WHAT the project is)

> **هُدَى (Huda) — Discord Academy**: a complete study-academy system running inside a private
> Arabic-speaking Discord server («مِداد» / Midad). The owner publishes Islamic-studies courses as
> YouTube lessons; members join scheduled voice-channel classes where the bot plays the lesson
> audio, track their reading and progress, take quizzes, and manage everything from rendered
> image cards inside Discord — no external app needed for members.

Last verified against code: 2026-10-14 (commit `c1ac9b2`).

---

## The 4 components

| Component | What it is | Entry point | Where it runs |
|---|---|---|---|
| **Academy Coach** (المدرب) | The 24/7 Discord bot. Scheduling, voice streaming, cards, quizzes, nudges, books, web API — everything. | `src/coach/index.js` | **Huawei MediaPad tablet** (Termux), LAN `192.168.100.87` |
| **Web dashboard «هُدَى»** | The owner's Arabic RTL control panel (SPA, no build step). Served by the Coach's Express on port **8420**. | `public/index.html` + `public/app.js` | Same host as the Coach (tablet) |
| **AI Admin studio** | Local Ollama-powered planning chat that publishes changes to the Coach API. Optional, effectively superseded by the SPA. | `src/ai-admin/index.js` | Owner's PC, port 8421 |
| **VideoBot sidecar** | Experimental separate process that screenshares the lesson *video* (H264 Go-Live). Currently dormant — the Coach only calls its `/stop`. | `src/videobot/videobot.cjs` | Same host as the Coach, port 8422 |

Stack: Node.js ≥ 22.5 (ESM), discord.js v14, `node:sqlite` (built-in `DatabaseSync` — **no** better-sqlite3), @discordjs/voice, Express, puppeteer-core (renders cards with the system browser), child processes `yt-dlp` + `ffmpeg`.

---

## Feature list (what the system does today)

**Courses & scheduling**
- Multiple courses, each with its own lesson list and its own cadence: specific weekdays (`days`), `daily`, or every-N-days (`interval`), at a local-time HH:mm.
- Long videos are auto-split into multi-part sessions («الجزء 2 من 3»), each part continuing where the last stopped (`sessions.offset_min`).
- YouTube playlist import — every video becomes a lesson (deduped by video id, real durations read via yt-dlp).
- Schedule generator fills the course's cadence slots with its planned lessons.

**Live classes (the core loop)**
- T-30 min: reminder post + audio prefetch into `data/cache/lesson-<id>.opus`.
- T-0: bot joins the «الحصة» voice channel and streams the lesson audio (members watch the video muted). Only **one live class at a time** across all courses.
- Attendance recorded from voice joins/leaves. Finish → attendance XP + streak bonus + `session_done` post + the lesson's quiz questions go out as answer buttons.
- Empty room after 15 min → «missed» poll with move / pick-a-time / skip buttons; no answer in 24 h → auto-move.
- On-demand «start class now» from the dashboard; live player controls (pause/seek/restart/volume) from the dashboard.

**Members**
- Per-member **private progress channel** (`تقدم-<name>`) with an interactive image-card dashboard: 5 tabs (نظرة عامة / الدورات / الكتبي / الإنجاز / الإشعارات), mark-lesson-complete, log book page, subscribe to course alerts, tick quest items, download book PDFs.
- «متعلم» (learner) role auto-granted on **any** interaction; pinged for new courses/groups.
- Per-course alert subscription: grants the course role `🔔 <title>`; class pings prefer course role → individual mentions → fallback ping role.
- Daily check-in nudges (DM, 18:00 by default, 48 h cooldown); weekly Sunday recap; daily 9 AM health heartbeat DM to the boss.

**Books & library**
- Books with page progress (auto-finished at last page); study groups with join / log-page buttons; personal reading without a group.
- «📚-المكتبة» read-only channel: one rendered card per book + «📝 سجّل صفحتك».
- PDF library: mods drop PDFs in «📥-رفع-الكتب» (or right-click any message → «📚 نشر في المكتبة»); the file is posted as a genre-tagged thread in the pre-existing forum «📚〡المكتبة・الشرعية» (25 MB cap). Members download via a dropdown on their كتبي tab — the bot re-fetches fresh (Discord attachment URLs expire).

**Quizzes** — multiple-choice per course/lesson, auto-posted after each class, one answer per member, XP for correct.

**Quests** — owner-managed achievement checklist (categories: كتاب/محاضرة/دورة), no XP, ticked via Discord button.

**XP/levels**: intentionally **removed from all user-facing surfaces** (owner decision). XP still accrues internally in the DB and powers streaks/leaderboard data in the API, but no XP messages, level roles, or leaderboards are shown. Do not re-add them.

**Owner dashboard (SPA)**: overview + live player, courses & course detail (lessons/sessions/roster/quiz), books & groups, members (search, drawer, rename/remove), quests, settings.

---

## Core concepts & vocabulary

| Term (code) | Arabic in UI | Meaning |
|---|---|---|
| Course | دورة | A study course: own lessons + own cadence + own role + own subscriber set. |
| Lesson | درس | One YouTube video (title, url, duration, `video_id`, `video_duration_sec`). |
| Session | حصة | One scheduled class of a lesson at a UTC ISO time; statuses: `scheduled → reminded → live → done` / `missed_poll → (moved)`. |
| Part | جزء | Slice of a long video: `offset_min` = minutes into the video this session starts. |
| Attendance | حضور | Voice joins/leaves during a live session → minutes per member. |
| Participant | عضو | Anyone who ever joined a class / interacted; gets a private channel. |
| Course sub | اشتراك | Per-course notification opt-in (`course_subs`) + course role. |
| Quest | عنصر الإنجاز | Checklist item (book/lecture/course category) ticked by members. |
| Book / Book progress | كتاب / صفحة | Reading with page tracking; `finished` auto at last page. |
| Study group | مجموعة قراءة | Group reading one book together; each member logs their page. |
| Member dashboard | لوحة العضو | The private per-member image-card board (5 tabs). |
| Hub | لوحة الأكاديمية | «📊-لوحة-الأكاديمية»: pinned onboarding + course join cards + live stats card. |
| Nudge | تنبيه | Daily DM to members who haven't finished the current lesson. |
| Recap | الملخص الأسبوعي | Weekly stats post + falling-behind DM to the boss. |
| Boss | المالك | The owner: Discord user ids in `BOSS_IDS` (env). |
| Card | بطاقة | HTML→PNG image rendered by `src/coach/card.js`. |

---

## Reading order for the rest of the docs

- How the code is wired → `2-ARCHITECTURE.md`
- Data model / settings keys → `3-DATABASE.md`
- Discord channels, commands, buttons, cards → `4-DISCORD-SURFACES.md`
- Dashboard SPA + HTTP API → `5-WEB-DASHBOARD-API.md`
- Hosting / deploy / runbooks → `6-DEPLOYMENT-OPS.md`
- Hard rules & known bugs → `7-GOTCHAS-KNOWN-BUGS.md`
- Tests & dev workflow → `8-TESTING-DEV-WORKFLOW.md`
