# Deploying Academy Coach to Oracle Cloud (Always Free ARM)

Target: OCI Always Free **VM.Standard.A1.Flex** (4 OCPU / 24 GB RAM / 50 GB boot volume — free
forever), Ubuntu 22.04+ image, in the tenancy of midad.azkar@gmail.com.

## 1. Create the VM (OCI console)

- Compute → Create Instance
- Name: `academy-coach`
- Shape: VM.Standard.A1.Flex, 2–4 OCPU, 12–24 GB (anything ≥1 OCPU/4 GB works)
- Image: Canonical Ubuntu 22.04 (or 24.04)
- Boot volume: default 47 GB is fine (audio cache lives here; ~100 MB per lesson)
- SSH key: paste `~/.ssh/academy_vm.pub` (generated on the workstation with
  `ssh-keygen -t ed25519 -f ~/.ssh/academy_vm`)
- Security list: keep default (ingress 22 only). The dashboard is reached through an SSH
  tunnel, never exposed publicly.

## 2. Bootstrap (once, as root on the VM)

```bash
bash deploy/setup-vm.sh
```

Installs ffmpeg, chromium-browser (card rendering), Node 22, yt-dlp, creates the `coach`
user, installs the systemd unit, enables the firewall.

## 3. Ship the code (from the Windows workstation)

```bash
# bundle (no git remote needed) — includes all commits
git bundle create academy.bundle master
scp academy.pem academy.bundle <vm-ip>:
# on the VM:
git clone academy.bundle /opt/discord-academy
```

Secrets + data go separately (never committed):

```bash
scp .env data/academy.db <vm-ip>:/opt/discord-academy/   # and /data/ for the db
scp data/cookies.txt <vm-ip>:/opt/discord-academy/data/  # YouTube cookies (REQUIRED on datacenter IP)
```

Then on the VM:

```bash
cd /opt/discord-academy
sudo -u coach npm ci --omit=dev
sudo -u coach mv ~/academy.db data/ 2>/dev/null || true
chown -R coach:coach .
systemctl start coach
journalctl -u coach -f
```

## 4. Use the dashboard securely

```bash
ssh -i ~/.ssh/academy_vm -L 8420:localhost:8420 coach@<vm-ip>
# then open http://127.0.0.1:8420 locally
```

## 5. YouTube cookies on the VM (mandatory — datacenter IPs are bot-blocked)

The VM's IP has no browsing history, so yt-dlp hits "Sign in to confirm you're not a bot"
on nearly every video. Export cookies from the midad.azkar@gmail.com browser session
(Netscape format) and drop them at `/opt/discord-academy/data/cookies.txt` — every yt-dlp
spawn picks them up automatically at spawn time (`src/coach/ytdlp.js`), no restart needed.

- Cookies expire every ~6 months: when classes silently stop caching, re-export.
- Keep the account dedicated to the bot (owner's decision — already the plan).

## Notes

- `tools/yt-dlp.exe` is the Windows build; on Linux the service overrides with
  `YTDLP_PATH=/usr/local/bin/yt-dlp` (set in coach.service).
- Cards render with `BROWSER_PATH=/usr/bin/chromium-browser` on Linux.
- Backups: `sqlite3 data/academy.db ".backup data/backup-$(date +%F).db"` in a daily cron;
  audio cache can be evicted freely (`data/cache/*.opus` re-download on demand).
