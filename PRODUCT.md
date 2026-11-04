# PRODUCT.md — Discord Academy Control Panel

> Inferred from the working session brief (2026-10-05). Assumptions labeled.
> Written per `impeccable init`, abbreviated: the product already exists in code
> and live use; this file records what a from-context reconstruction cannot know.

## Product

**Academy Coach** — a Discord-based study academy for a private Arabic-speaking
server ("Midad"). The owner runs a training course as YouTube lessons; members
join a scheduled voice-channel class, listen together (bot streams the lesson
audio), earn XP/streaks/levels, and get check-in nudges. A second local app
(AI Server Manager) plans the course with a local LLM and publishes changes.

The dashboard being built is the **owner's control panel**: start classes,
manage lessons and schedule, inspect members, quests, settings. Used daily,
mostly from desktop, sometimes phone. Language: **Arabic, RTL**.

## Surface brief — dashboard (Mode: Operate)

- Primary jobs, in priority order:
  1. Start a class NOW (one click → bot joins VC + streams lesson audio)
  2. Add / edit / remove / reorder lessons (YouTube URL is mandatory data)
  3. See who's engaged: search members, open a member's full activity record
  4. Schedule control: weekly template, per-session move/cancel, auto-fill
  5. Quests + settings tuning
- Operator: the server owner (technical, impatient, action-first). Prior
  rejection: "stats-first" pages with no actions; anything requiring slash
  commands or manual Discord steps. Every control must be a visible button.
- Data reality: often-empty course lists, 1–30 members, occasional live class.
  Empty states must guide the next action, not just say "no data".
- Constraints: no build step (static files served by the Coach's Express from
  `public/`), cookie auth, JSON API at `/api/dash/*` (see DASHBOARD_API.md).
  Deploys unchanged to the bot-hosting.net container.

## Visual world (pinned by owner, 2026-10-05)

**Ink & amber** — refined dark: deep ink background, warm amber/gold as the
single accent, Tajawal typography, crisp tables, zero glow/gradient clichés.
Distinctly not the generic blue-purple AI look.

## Out of scope

Member-facing UI (lives in Discord).
