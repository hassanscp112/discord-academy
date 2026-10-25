# 3 — Database Reference (schema, settings, migrations)

Single SQLite file at `DB_PATH` (default `./data/academy.db`), opened by `node:sqlite`
`DatabaseSync` with `journal_mode=WAL`, `foreign_keys=ON`. Schema + migrations live ONLY in
`src/core/db.js` (`getDb()`) — the function runs on first import and is a singleton.
**All timestamps are UTC ISO strings.** Cadence times (HH:mm) are local-tz strings.

Migrations are additive `ALTER TABLE … ADD COLUMN` wrapped in `try{}catch{}` (v2…v10) plus
`CREATE TABLE IF NOT EXISTS` — safe on every boot.

## Tables (18)

### courses
| Column | Meaning |
|---|---|
| id, title, position | Course identity + order in lists |
| mode | Cadence mode: `days` \| `daily` \| `interval` |
| days | Comma weekday numbers `0-6` (0=Sunday) for `days` mode |
| every_n | Every N days for `interval` mode (1–30) |
| time | Class time, local tz `HH:mm` (default 21:00) |
| role_id | Discord id of the course role `🔔 <title>` |
| reg_msg_id | Discord id of this course's join-card message in the hub |

### lessons
| Column | Meaning |
|---|---|
| id, position | Identity + order within the course |
| title, url | YouTube title/link |
| duration_min | Class length in minutes (default 60) — used for part splitting |
| status | `planned` \| `done` \| `skipped` |
| video_id | YouTube video id (dedupe key for playlist imports) |
| video_duration_sec | Real video length (yt-dlp) — a 2 h video @60-min classes → 2 sessions |
| course_id | Owning course (FK; 0 impossible after migration) |

### sessions
| Column | Meaning |
|---|---|
| id, lesson_id | Identity; cascade-deleted with the lesson |
| scheduled_at | UTC ISO start time |
| status | `scheduled` → `reminded` → `live` → `done` / `missed_poll` (then moved) |
| live_post_id | Discord id of the "starting" message (for the finish button) |
| proposed_at | Slot proposed by the missed-poll (nullable) |
| poll_at | When the missed poll was posted (auto-move 24 h later; cleared after) |
| offset_min | Minutes into the video this part starts (part splitting) |

### participants
| Column | Meaning |
|---|---|
| user_id (PK) | Discord user id |
| display_name | Shown in dashboards/cards |
| joined_at, dms_enabled (0/1), last_nudged_at | Nudge logic |
| private_channel_id | Discord id of the member's `تقدم-<name>` channel |

### progress — lesson completions. PK `(user_id, lesson_id)`, `completed_at`.

### attendance — PK `(session_id, user_id)`; `joined_at`, `left_at`, `minutes` (computed on leave; open rows closed at finalize).

### xp_events — append-only XP log: `user_id, amount, reason, created_at`. (XP still recorded internally; just not surfaced to users.)

### quests — owner-managed checklist: `title, description, category` (`book` \| `lecture` \| `course`; default `lecture`), `status` (`active`/`ended`), `lesson_ids` (legacy JSON), dates/xp (legacy, unused).

### quest_completions — PK `(quest_id, user_id)`, `completed_at`. First completion of an item is announced.

### nudges_log — `user_id, kind` (`dm`/`channel`), `sent_at`.

### books — `title, total_pages, genre`, `library_msg_id` (card message in «📚-المكتبة»), PDF fields: `pdf_msg_id` (forum thread id), `pdf_name`, `pdf_size`, `genre`.

### book_progress — PK `(book_id, user_id)`: `page`, `finished` (auto-set when page ≥ total), `updated_at`.

### study_groups — `title, book_id, status` (active/ended).

### study_group_members — PK `(group_id, user_id)`, `joined_at`.

### course_subs — per-course notification opt-in. PK `(course_id, user_id)`, `joined_at`. Subscribing also grants the course role.

### questions — quiz: `course_id` (FK), nullable `lesson_id`, `question`, `options_json` (JSON array, up to 5), `correct_index`, `xp` (default 10).

### question_answers — PK `(question_id, user_id)`: one answer per member, `correct` 0/1.

### settings — simple `key TEXT PRIMARY KEY, value TEXT`. See below.

## Settings keys (defaults from `db.js` DEFAULT_SETTINGS, current values live in the DB)

### Discord wiring (set by `/setup` or boot ensures)
| Key | Meaning |
|---|---|
| `channel_dashboard` | Announcements channel («إعلانات-الأكاديمية») — reminders, starting posts, quizzes, group/quest announcements |
| `study_vc` | «الحصة» voice channel id (also ensured at boot) |
| `ping_role` | Fallback ping role when a course has no subscribers/role |
| `learner_role_id` | «متعلم» role id (auto-grant on any interaction) |
| `academy_dash_msg` | Hub live-stats card message id |
| `hub_order_v1`, `legacy_dash_removed` | One-time migration flags (hub ordering / old dashboard cleanup) |

### Schedule / engine timing
| Key | Default | Meaning |
|---|---|---|
| `tz` | (falls back to env `TZ`) | Academy timezone, drives all local-time math |
| `reminder_minutes_before` | 30 | Reminder + prefetch before class |
| `missed_after_minutes` | 15 | Empty-room threshold → missed poll |
| `nudge_hour` | 18 | Daily nudge hour (local) |
| `nudge_over_dm` | 1 | 1 = DM members, 0 = one channel post |
| `nudge_cooldown_hours` | 48 | Min hours between nudges per member |
| `recap_day` / `recap_hour` | 0 (Sunday) / 21 | Weekly recap |
| `health_hour` | 9 | Daily heartbeat DM to boss |
| `reminder_minutes_before` | 30 | (as above) |
| `dashboard_refresh_minutes` | 5 | Legacy (old text dashboard) |

### XP (internal only — do not surface to users)
`xp_attendance` 25* — paid per attended session; `xp_completion` 50; `xp_quest` 150; `xp_streak_bonus` 10; `xp_streak_bonus_cap` 50; `levels_json` (level table); `level_roles` 1 (stubbed off).
(*DB default is 20/50 in code; live values may differ — read the DB, don't assume.)

### Internal state (do not hand-edit casually)
| Key | Meaning |
|---|---|
| `revision` | Optimistic-concurrency counter for `/api/publish` |
| `weekly_template_json` | Legacy global cadence (v4 migration source; `/schedule template` + `/api/dash/template` still write it, syncing the FIRST course) |
| `nudge_last_run`, `recap_last_run`, `health_last_run` | Date guards so each daily/weekly job runs once |

## Discord id → where it's stored
| Discord entity | Storage |
|---|---|
| Course join card msg | `courses.reg_msg_id` |
| Book library card msg | `books.library_msg_id` |
| Book PDF forum thread | `books.pdf_msg_id` |
| Live "starting" msg | `sessions.live_post_id` |
| Member private channel | `participants.private_channel_id` |
| Hub stats card msg | setting `academy_dash_msg` |
| Announcements channel / VC / ping role / learner role | settings `channel_dashboard` / `study_vc` / `ping_role` / `learner_role_id` |

## Most-used `academy.js` functions by area (all take/return plain rows)

- Courses: `listCourses`, `createCourse`, `updateCourse`, `removeCourse` (refuses last course), `courseWithTemplate`.
- Lessons: `addLesson` (reads video meta when url given), `listLessons(courseId)`, `removeLesson`, `reorder`, `importPlaylist` (dedupes by `video_id` academy-wide).
- Schedule: `generateScheduleForCourse(courseId,{count,from})`, `generateSchedule()`, `setSession`, `pushToNextSlot`, `cancelSession`, `listSessions({future,limit})`, `nextSession`, `currentLesson`, `lessonParts`, `sessionPartInfo`, `nextOffsetForLesson`.
- Members: `upsertParticipant`, `listParticipants`, `completeLesson` (idempotent), `courseProgress`, `courseRoster`, `currentStreak`, `xpTotal`, `levelFor`, `renameParticipant`, `removeMember` (wipes ~10 tables).
- Attendance: `recordJoin`, `recordLeave`, `sessionAttendance`, `finalizeSession`.
- Books/groups: `addBook`, `removeBook`, `setBookProgress`, `bookShelf`, `bookStats`, `setBookPdf`, `createGroup`, `joinGroup`/`leaveGroup`, `groupRoster`.
- Subs/quiz: `toggleCourseSub`, `courseSubscribers`, `subscribedCourses`, `addQuestion`, `listQuestions`, `answerQuestion`.
- Aggregates: `overview()` (dashboard/studio), `weeklyRecap`, `membersToNudge`.
