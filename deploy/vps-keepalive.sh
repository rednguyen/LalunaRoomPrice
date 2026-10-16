#!/usr/bin/env bash
# Install the "always-open SiteMinder browser" service on the VPS. Run as root:  bash vps-keepalive.sh
#
# It keeps ONE full Chromium open on a virtual screen, on the bot's profile, with a local debug
# port (127.0.0.1:9222). The report and trust workflows ATTACH to it (SM_CDP_URL) instead of
# launching their own browser — so SiteMinder only ever sees the single device you trusted, and
# stops dropping the trust after each run. Safe to re-run.
#
# One profile = one process: do NOT also open "SiteMinder (bot profile)" on the RDP desktop while
# this service runs (it would fight over the profile). Use the trust workflow to log in/trust.
set -euo pipefail
BOT_USER="laluna"
HOME_DIR="/home/$BOT_USER"
# Must match UA in src/auth.js and the SPID.
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"
SPID="${SM_SPID:-f480c881-63c3-4a11-8d81-bba590c4bbca}"

[ "$(id -u)" -eq 0 ] || { echo "Run as root: bash $0"; exit 1; }
id "$BOT_USER" &>/dev/null || { echo "Run vps-setup.sh first (no $BOT_USER user)."; exit 1; }
command -v Xvfb >/dev/null || { echo "Installing xvfb…"; apt-get update && apt-get install -y xvfb; }

cat > "$HOME_DIR/sm-keepalive.sh" <<EOF
#!/usr/bin/env bash
set -u
export HOME=$HOME_DIR DISPLAY=:99
PROFILE=$HOME_DIR/sm-profile
pgrep -f "Xvfb :99" >/dev/null || Xvfb :99 -screen 0 1920x1080x24 >/dev/null 2>&1 &
sleep 2
CHROME=\$(ls -d $HOME_DIR/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | sort -V | tail -1)
[ -x "\$CHROME" ] || { echo "Playwright Chromium not installed yet — run the report workflow once, then: systemctl restart sm-keepalive"; sleep 30; exit 1; }
while true; do
  rm -f "\$PROFILE/SingletonLock" "\$PROFILE/SingletonCookie" "\$PROFILE/SingletonSocket" 2>/dev/null || true
  "\$CHROME" --user-data-dir="\$PROFILE" --remote-debugging-port=9222 --remote-debugging-address=127.0.0.1 \\
    --no-sandbox --no-first-run --no-default-browser-check --password-store=basic --use-mock-keychain \\
    --user-agent="$UA" "https://platform.siteminder.com/dashboard/$SPID" >/dev/null 2>&1
  echo "chrome exited — restarting in 5s"; sleep 5
done
EOF
chmod +x "$HOME_DIR/sm-keepalive.sh"
chown "$BOT_USER:$BOT_USER" "$HOME_DIR/sm-keepalive.sh"

cat > /etc/systemd/system/sm-keepalive.service <<EOF
[Unit]
Description=Always-open SiteMinder browser (CDP 127.0.0.1:9222)
After=network-online.target
[Service]
User=$BOT_USER
ExecStart=$HOME_DIR/sm-keepalive.sh
Restart=always
RestartSec=10
[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now sm-keepalive

sleep 5
echo "== check: the debug port should answer =="
curl -fsS http://127.0.0.1:9222/json/version | head -c 200 || echo "(not answering yet — if Chromium isn't installed, run the report workflow once then: systemctl restart sm-keepalive)"
echo
echo "✅ sm-keepalive installed. Next: Actions → 'Trust VPS in SiteMinder' → Run workflow, then click the email link."
