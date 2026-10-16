#!/usr/bin/env bash
# Optional: a Remote Desktop (RDP) desktop on the VPS, to look at SiteMinder through the
# bot's own browser + profile. Safe to re-run. Run as root:
#
#   MY_IP=<your public IP> bash vps-desktop.sh     (MY_IP limits RDP to your IP — recommended)
#
# Then on Windows: Remote Desktop Connection → <VPS-IP> → user "laluna" + the password set here.
#
# The desktop icon "SiteMinder (bot profile)" opens Playwright's Chromium on
# /home/laluna/sm-profile — the same browser, profile and user agent the bot uses, so the
# trusted-device key and session are the bot's. CLOSE IT before a report run: one profile
# can't be open twice, and a manual login there counts as a login for the bot user.
set -euo pipefail

BOT_USER="laluna"
HOME_DIR="/home/$BOT_USER"
MY_IP="${MY_IP:-}"
# Must match UA in src/auth.js — the trusted-device token is tied to the user agent.
UA="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36"
export DEBIAN_FRONTEND=noninteractive

[ "$(id -u)" -eq 0 ] || { echo "Run as root: bash $0"; exit 1; }
id "$BOT_USER" &>/dev/null || { echo "Run vps-setup.sh first (no $BOT_USER user)."; exit 1; }

echo "== 1. Desktop + Remote Desktop server"
apt-get update
apt-get install -y xfce4 xfce4-terminal dbus-x11 xrdp
adduser xrdp ssl-cert >/dev/null 2>&1 || true
echo "xfce4-session" > "$HOME_DIR/.xsession"
chown "$BOT_USER:$BOT_USER" "$HOME_DIR/.xsession"
systemctl enable --now xrdp
systemctl restart xrdp

echo "== 2. Password for $BOT_USER (Remote Desktop login)"
if ! passwd -S "$BOT_USER" | grep -q " P "; then
  echo "Choose a password for $BOT_USER:"; passwd "$BOT_USER"
else
  echo "   (already has a password — change it with: passwd $BOT_USER)"
fi

echo "== 3. Desktop icon: SiteMinder in the bot's browser + profile"
cat > "$HOME_DIR/sm-browser.sh" <<EOF
#!/usr/bin/env bash
# Opens SiteMinder in the bot's own Chromium + profile (see vps-desktop.sh).
CHROME=\$(ls -d $HOME_DIR/.cache/ms-playwright/chromium-*/chrome-linux*/chrome 2>/dev/null | sort -V | tail -1)
[ -x "\$CHROME" ] || { zenity --error --text="Bot browser not installed yet — run the report workflow once." 2>/dev/null; exit 1; }
if pgrep -f -- "--user-data-dir=$HOME_DIR/sm-profile" >/dev/null; then
  zenity --error --text="The bot's profile is in use (a report run, or already open). Try again later." 2>/dev/null; exit 1
fi
# --no-sandbox: Ubuntu 24.04's AppArmor blocks Chromium's sandbox ("No usable sandbox!");
# Playwright starts the bot's Chromium with it too, so this matches the bot exactly.
exec "\$CHROME" --user-data-dir=$HOME_DIR/sm-profile --password-store=basic --use-mock-keychain --no-sandbox \\
  --user-agent="$UA" --no-first-run https://authx.siteminder.com/login
EOF
chmod +x "$HOME_DIR/sm-browser.sh"
install -d -o "$BOT_USER" -g "$BOT_USER" "$HOME_DIR/Desktop"
cat > "$HOME_DIR/Desktop/siteminder-bot.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=SiteMinder (bot profile)
Comment=The bot's own browser and SiteMinder profile — close before a report run
Exec=$HOME_DIR/sm-browser.sh
Icon=web-browser
Terminal=false
EOF
chmod +x "$HOME_DIR/Desktop/siteminder-bot.desktop"
chown "$BOT_USER:$BOT_USER" "$HOME_DIR/sm-browser.sh" "$HOME_DIR/Desktop/siteminder-bot.desktop"
apt-get install -y zenity >/dev/null 2>&1 || true

echo "== 4. Firewall: Remote Desktop (port 3389)"
if [ -n "$MY_IP" ]; then
  ufw allow from "$MY_IP" to any port 3389 proto tcp
else
  ufw allow 3389/tcp
fi

cat <<EOF

✅ Remote Desktop ready.
   Windows: Remote Desktop Connection → this server's IP → user: $BOT_USER, the password above.
   On the desktop, double-click "SiteMinder (bot profile)" (first time: "Trust and launch").
   Close that browser before a report runs.
EOF
[ -n "$MY_IP" ] || echo "⚠️  RDP is open to the whole internet. Re-run with MY_IP=<your IP> to restrict it, then: ufw delete allow 3389/tcp"
