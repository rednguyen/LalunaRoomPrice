# VPS setup (Ubuntu)

The daily report runs on an Ubuntu VPS as a GitHub **self-hosted runner**. cron-job.org keeps
triggering it as before. The VPS keeps SiteMinder's **trusted browser profile**
(`/home/laluna/sm-profile`), which is what lets the report reveal Booking.com / Agoda guests' emails
and send them the cancellation feedback email. Everything is headless: you only ever use SSH.

## 1. Connect
From PowerShell on your PC:
```powershell
ssh root@<VPS-IP>
```
Type `yes` the first time, then the root password from your provider. (Typing a password
shows nothing on screen. That's normal.)

## 2. Run the setup script
On the VPS:
```bash
nano vps-setup.sh        # paste deploy/vps-setup.sh, then Ctrl+O, Enter, Ctrl+X
bash vps-setup.sh
```
Takes ~5–10 minutes. It ends with "✅ VPS ready".

## 3. Register the GitHub runner
GitHub repo → **Settings → Actions → Runners → New self-hosted runner → Linux, x64**.
On the VPS:
```bash
su - laluna
cd ~/actions-runner
# paste GitHub's "Download" commands (curl … tar …), then its ./config.sh line
```
`./config.sh` asks a few questions: press Enter for the defaults, **except labels: type `laluna`**.
Then make it run in the background (and after reboots):
```bash
exit                                   # back to root
cd /home/laluna/actions-runner
./svc.sh install laluna && ./svc.sh start
```
GitHub's Runners page should now show the runner as **Idle**.

## 4. Secrets and variables
GitHub repo → **Settings → Secrets and variables → Actions**:

| Kind | Name | Value |
|---|---|---|
| Secret | `GMAIL_USER` | `hoianlaluna@gmail.com` |
| Secret | `GMAIL_APP_PASSWORD` | the 16-character App Password |
| Secret | `GMAIL_FROM` | `Laluna Hoi An Riverside Hotel & Spa <hoianlaluna@gmail.com>` |
| Variable | `GUEST_EMAIL_MODE` | `dry-run` first; `live` to really email guests |

The SiteMinder and Zalo secrets already exist and are reused.

## 5. Trust the VPS in SiteMinder (once)
**Actions → Trust VPS in SiteMinder → Run workflow.** When SiteMinder's "trusted device" email
arrives, click its link within 5 minutes. The run turns green ✅.

## 6. First run
**Actions → OTA Sales Report → Run workflow (runner: vps, Post to Zalo: no).** The "Run report"
log should show `✉️ [dry-run] …: would email …` — the guest-email reveal working on the VPS.

## 7. Go live
1. **Variable `GUEST_EMAIL_MODE` → `live`** (Settings → … → Variables).
2. **Re-enable cron-job.org.**
3. One manual run (runner: vps, Post to Zalo: **yes**) to confirm: a new Booking.com
   cancellation shows `✉️ Đã hỏi thăm khách trên Extranet` in Zalo and the guest gets the email.

## ⚠️ The one rule
**Never open the "SiteMinder (bot profile)" browser on the VPS desktop** (deploy/vps-desktop.sh
installs that icon). It's a *different* Chromium build than the one the workflows use, and
opening it on the profile makes SiteMinder **revoke the trusted device** — then the reveal
breaks until you re-run step 5. The report/trust workflows run the full Chromium under **xvfb**
(installed by vps-setup.sh) so SiteMinder always sees the one trusted device; don't bypass that.
If you only ever use SSH + the GitHub workflows, you'll never hit this.

## Day to day
- **VPS down?** Actions → OTA Sales Report → Run workflow → **runner: github**. The reports go
  out; guest emails wait until the VPS is back.
- **Emails stopped / no ✉️ notes?** SiteMinder dropped the trust: re-run step 5 (and check
  nobody opened the bot-profile browser).
- **Never twice:** emailed guests are logged in `state/emailedGuests.json`.
