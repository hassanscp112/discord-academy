#!/usr/bin/env bash
# Oracle VM bootstrap for Discord Academy Coach — run once as root on Ubuntu 22.04/24.04 (ARM or x86).
# Usage: bash setup-vm.sh
set -euo pipefail

APP_DIR=/opt/discord-academy

echo "== system packages =="
apt-get update -y
apt-get install -y curl ffmpeg chromium-browser git sqlite3

echo "== node 22 (node:sqlite needs >=22.5) =="
if ! command -v node >/dev/null || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
node -v

echo "== yt-dlp (linux binary; keep it fresh — YouTube breaks old builds) =="
curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp
chmod +x /usr/local/bin/yt-dlp
/usr/local/bin/yt-dlp --version

echo "== app user + dir =="
id -u coach >/dev/null 2>&1 || useradd -r -m -d /home/coach -s /bin/bash coach
mkdir -p "$APP_DIR" /opt/discord-academy/data/cache
# code lands via the deploy runbook (git bundle or rsync from the workstation):
chown -R coach:coach "$APP_DIR"

echo "== systemd service =="
cp "$APP_DIR"/deploy/coach.service /etc/systemd/system/coach.service 2>/dev/null \
  || echo "NOTE: deploy/ not present yet — copy coach.service manually after the code lands"
systemctl daemon-reload
systemctl enable coach 2>/dev/null || true

echo "== firewall: dashboard stays off the public internet (use SSH tunnel) =="
ufw allow OpenSSH >/dev/null 2>&1 || true
# do NOT open 8420 publicly; access via: ssh -L 8420:localhost:8420 coach@VM

echo "DONE. Next:"
echo "  1. upload code + .env + data/ to $APP_DIR"
echo "  2. cd $APP_DIR && sudo -u coach npm ci --omit=dev"
echo "  3. systemctl start coach && journalctl -u coach -f"
