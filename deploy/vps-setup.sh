#!/usr/bin/env bash
# One-time setup for the Ubuntu VPS that runs the daily report as a GitHub self-hosted
# runner. Safe to re-run. Run as root:   bash vps-setup.sh
#
# Installs: user "laluna" (runs the GitHub runner), 2 GB swap, Node 20, Git, the system
# libraries Playwright's Chromium needs, and a firewall that only allows SSH.
# Everything runs headless — no desktop needed.
set -euo pipefail

BOT_USER="laluna"
HOME_DIR="/home/$BOT_USER"
PLAYWRIGHT_VERSION="1.64.0"   # keep in step with package-lock.json
export DEBIAN_FRONTEND=noninteractive

[ "$(id -u)" -eq 0 ] || { echo "Run as root: sudo bash $0"; exit 1; }

echo "== 1. User $BOT_USER"
id "$BOT_USER" &>/dev/null || adduser --disabled-password --gecos "" "$BOT_USER"
# Outside the runner's workspace (checkout wipes that): SiteMinder's trusted browser profile.
install -d -o "$BOT_USER" -g "$BOT_USER" "$HOME_DIR/sm-profile" "$HOME_DIR/actions-runner"

echo "== 2. Swap (2 GB, if none)"
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "== 3. Packages"
apt-get update
apt-get install -y curl git ca-certificates ufw xvfb   # xvfb: virtual screen for the visible bot browser
if ! node -v 2>/dev/null | grep -q '^v20\.'; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi
# System libraries for Playwright's Chromium (the browser itself is downloaded by the workflow).
npx -y "playwright@$PLAYWRIGHT_VERSION" install-deps chromium

echo "== 4. Time zone + firewall"
timedatectl set-timezone Asia/Ho_Chi_Minh || true
ufw allow OpenSSH
ufw --force enable

cat <<EOF

✅ VPS ready. Next: register the GitHub runner (see VPS_SETUP.md, step 3):
   su - $BOT_USER
   cd ~/actions-runner
   ...paste GitHub's download + ./config.sh commands (labels: laluna)...
   exit
   cd $HOME_DIR/actions-runner && ./svc.sh install $BOT_USER && ./svc.sh start
EOF
