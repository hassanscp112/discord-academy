# Deploy

Full runbook: [`docs/6-DEPLOYMENT-OPS.md`](../docs/6-DEPLOYMENT-OPS.md). In short:

| Where | Status | How it runs |
|---|---|---|
| **bot-hosting.net** | **primary** (since 2026-11-04) | Node.js 24 deployment cloned from GitHub (`hassanscp112/discord-academy`, branch `main`), entry file `scripts/start.js`, auto-pull on restart. `start.js` fetches yt-dlp, Chrome headless shell and the emoji font into `tools/` on first boot. |
| Android tablet (Termux) | retired | `~/.termux/boot/academy.sh` supervisor loop; see docs/6 if it is ever revived. |
| Windows PC | fallback | `install-task.ps1` registers the `AcademyCoach` scheduled task (start at logon, restart on crash). Only run it while the primary is **stopped** — two bots double-post. |

Ship a change: commit → `git push origin master:main` → **Restart** in the bot-hosting.net panel (it pulls `main` first).

`lavalink/application.yml` — config for the optional (not recommended) Lavalink audio node.
