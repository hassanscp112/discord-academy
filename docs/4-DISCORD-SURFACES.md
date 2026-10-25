# 4 — Discord Surfaces (channels, roles, commands, buttons, cards)

**Rule zero: every user-facing string is Arabic.** No English ever reaches a member.
Templates live in `src/core/templates.js`; card HTML in `src/coach/card.js`; inline strings sit in
the owning module. Owner preference: **image cards, not text embeds** — when the renderer works,
a "message" is just a JPEG + buttons.

## Channels managed by the bot

| Channel (exact name) | Type | Owner module | Notes |
|---|---|---|---|
| `📊-لوحة-الأكاديمية` | Text | `acadashboard.js` | **The hub**: pinned onboarding card → per-course join cards → live stats card. `@everyone` denied Send. Order enforced one-time by `ensureHubOrder`. |
| `إعلانات-الأكاديمية` (id in setting `channel_dashboard`) | Text | set via `/setup` | Announcements: reminders, starting/missed/done posts, quizzes, group & quest announcements. Read-only for members. |
| `الحصة` | Voice | `acadashboard.js` (`ensureVoiceChannel`) | The classroom. Bot joins self-deafened and streams lesson audio. |
| `📊 تقدم الأعضاء` | Category | `memberdash.js` | Hidden (`@everyone` denied ViewChannel). |
| `تقدم-<member name>` | Text (per member) | `memberdash.js` | One per participant (`participants.private_channel_id`); member-only + bot overwrites; pinned interactive card. |
| `📚-المكتبة` | Text | `library.js` | Read-only; one rendered card per book. |
| `📥-رفع-الكتب` | Text | `uploads.js` | Mods-only posting (grant Send to mod roles manually); pinned instructions; PDF drop zone. |
| `📚〡المكتبة・الشرعية` | Forum | `pdflib.js` | **Pre-existing — found by name, never created.** Each book's PDF = one genre-tagged thread. |
| `🔔-التسجيل-بالدورات` | Text (legacy) | `coursereg.js` | Auto-deleted if it still exists (cards moved to the hub). |

Gotchas: Discord normalizes channel-name **spaces → dashes** (match the dashed form); when
looking up a text channel by name, filter `GuildText` (not forums/announcements types).

## Roles

| Role | Color | Granted | Removed |
|---|---|---|---|
| `متعلم` (learner) | navy | **On every interaction** (`grantLearnerRole` in `interactionCreate`) + boot ensure | manual |
| `🔔 <course title>` (per course) | amber | `csub:` / `sub:` on (subscribe) | `cunsub:` / `sub:` off |
| `@Students`-style ping role | — | n/a — fallback ping only (setting `ping_role`) | — |

Class-start ping order: course role → individual subscriber mentions → `ping_role` → `@here`.
New-course and new-group announcements ping `متعلم` (`learnerPing()`).
Level roles were **removed** — `gamification.js` is a stub; do not re-add.

## Slash commands (guild-registered at boot; default perm = ManageGuild unless noted)

| Command | Subcommands / options | Who |
|---|---|---|
| `/lesson` | `add title* url duration` · `list` · `remove id*` | admins |
| `/schedule` | `template days* time*` (days like `sun,wed` or Arabic) · `generate` · `list` · `move id* date* time*` · `cancel id*` | admins |
| `/setup` | `dashboard` · `study_vc` · `ping_role` | admins |
| `/myprogress` | personal progress card | everyone |
| `/quest` | `list` | everyone |
| `/books` | personal shelf (كتبي) | everyone |
| `/group` | `list` · `join id*` · `page id* page*` · `leave id*` | everyone |
| `/pdf` | `add book* file* genre pages` · `remove book*` | admins |
| `/optout` | toggle check-in DMs | everyone |
| Context menu: `📚 نشر في المكتبة` | on any message with a PDF attachment | admins |

## Buttons — customId contract

`handleButton` splits on `:` into `[kind, action, idStr, slotIso]` — **for 2-segment ids the id
lands in `action`, NOT `idStr`** (this is a recurring bug source — see `7-GOTCHAS`).

| customId | Label | Effect | Created in |
|---|---|---|---|
| `complete:<lessonId>` | «✅ أنهيت هذا الدرس» | mark lesson complete | `sessions.js:218` |
| `sess:finish:<id>` | finish now | boss finishes live session (XP + quiz) | `sessions.js` |
| `sess:move:<id>` | accept proposed slot | move missed session | `sessions.js` |
| `sess:slots:<id>` | pick a time | boss-only ephemeral 3-option picker | `sessions.js` |
| `sess:set:<id>:<ISO>` | (ephemeral) | set exact time | `commands.js` |
| `sess:skip:<id>` | skip | cancel session, stop stream | `sessions.js` |
| `quiz:<qid>:<optIdx>` | option text | one answer per member; correct → XP | `sessions.js`, `web.js` |
| `csub:<courseId>` / `cunsub:<courseId>` | «🔔 الاشتراك / 🔕 إلغاء» | course sub + role toggle | `coursereg.js` |
| `sub:<courseId>` | «🔔 أشعرني / 🔕 إلغاء الإشعار» | same toggle, from member dashboard | `memberdash.js` |
| `mview:<view>` | tab nav (نظرة عامة/الدورات/كتبي/الإنجاز/الإشعارات) | switch member-dashboard tab; active tab = disabled button (view marker) | `memberdash.js` |
| `mcomplete:<courseId>` | «✅ أنهيت: <next lesson>» | complete next lesson of that course | `memberdash.js` |
| `mnoop:<courseId>` | «مكتملة» (disabled) | placeholder when course finished | `memberdash.js` |
| `bkpage:<bookId>` | «📝 سجّل صفحتك» | open page modal | `library.js`, `memberdash.js` |
| `grp:join:<gid>` / `grp:page:<gid>` | «📖 أنضم» / «📝 سجّل صفحتك» | join group / open page modal | `web.js` (group announcement) |
| `quest:check:<questId>` | «أنجزتها ✅» | tick checklist item (first tick announced) | `web.js`, `memberdash.js` |
| `pdfup:btn:<sourceMsgId>` | «✏️ العنوان والصفحات والتصنيف» | open PDF publish modal | `uploads.js` |
| `onboard:me` | «📊 افتح لوحتي» | points member to their private channel | `memberdash.js` (pinned onboarding) |

## Modals

| Modal customId | Fields | Effect |
|---|---|---|
| `grp:modal:<gid>` | page («وصلت إلى صفحة…») | set reading page |
| `bk:modal:<bookId>` | page | set reading page (personal, no group needed) |
| `pdfup:modal:<sourceMsgId>` | title, pages, genre | publish dropped PDF (forum thread + library card) |

## Select menus

| customId | Where | Effect |
|---|---|---|
| `pdfget` | member dashboard «كتبي» tab | download a book PDF — bot re-fetches fresh from the forum thread |

## Cards (rendered images)

All cards: width 860 px, RTL Arabic, Tajawal (inlined `fonts.css`), هُدَى emblem as base64
data-URI (`public/logo-card.png`), navy header + amber accents, screenshot of `#card` as JPEG
q88 DPR 1.5.

| Card | Builder | Where shown |
|---|---|---|
| Member dashboard (5 tabs) | `memberCardHTML` / `listCardHTML` via `viewCardHTML` | member's private channel (attachment `card.jpg`) |
| Book card | `bookCardHTML` | «📚-المكتبة» (`book.jpg`) |
| Onboarding guide | `onboardingCardHTML` | pinned in hub (`onboarding.png`) |
| Academy stats (live) | `academyCardHTML` | hub stats message (`academy.jpg`), 10-min throttle |

Interaction 3 s rule: any handler that renders a card must **defer first** (`deferUpdate`),
then edit the reply with the attachment. Renders are queued serially (`renderCard`).

## Message templates (`src/core/templates.js` keys)

`reminder`, `starting`, `missed`, `missed_auto_moved`, `session_done`, `completion_thanks`,
`nudge_dm` (3 rotating variants), `nudge_channel`, `quest_new`, `quest_done`, `group_new`,
`group_progress_line`, `recap` (+3 closing variants), `welcome_dm`. Placeholders look like
`{{lesson_title}}`, `{{time}}`, `{{ping}}`, `{{part_line}}` — filled by `fill()` in `sessions.js`.
Edit wording ONLY here, keep Arabic.
