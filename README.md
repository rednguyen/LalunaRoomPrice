# LalunaPriceService

Automated data pull from a **SiteMinder** account (Laluna Hoi An Riverside Hotel).
It logs in unattended via a headless browser, captures the authenticated session,
and calls SiteMinder's GraphQL API to export room-type **availability** to CSV.

> This automates access to the account owner's **own** SiteMinder data. Keep it to
> your own account and a reasonable request rate.

## How it works

SiteMinder login is Auth0-based with MFA and trusted-device enrollment, and the app
API is cookie-authenticated. The pipeline:

1. **Login** (`src/auth.js`) — Playwright drives the real login:
   email → password → TOTP (generated from a stored secret) → trusted-device step →
   lands on `platform.siteminder.com`. The session (cookies + storage) is saved to
   `state/storageState.json`.
2. **Trusted device** — two modes via `SM_DEVICE_TRUST`:
   - `skip` — log in as an untrusted, session-only device.
   - `confirm` — auto-confirm the "trusted device" email. The email is read over
     **IMAP** (`src/gmail.js`); SiteMinder sends it to the login address, which is
     forwarded to the mailbox configured in `GMAIL_USER`.
3. **Data fetch** (`src/graphql.js`, `src/fetchAvailability.js`) — loads the saved
   session, navigates to the dashboard (so the app sets `sm_access_token` +
   `sm_xsrf_token`), then POSTs to the GraphQL endpoint with the `sm_xsrf_token`
   value sent as the `x-xsrf-token` header. Reuses the saved session and only
   re-logs in if it returns 401.

### GraphQL endpoint

`POST https://platform.siteminder.com/api/cm-beef/graphql` — operation `roomTypeDates`
returns `{ date, roomTypeUuid, available }` per room-type per date. The date range is
chunked (default 30 days/request) and recombined, so large windows (e.g. a full year)
work reliably.

## Project structure

```
src/auth.js              Automated login + session capture
src/gmail.js             IMAP reader for the trusted-device confirmation email
src/graphql.js           Authenticated GraphQL client (session reuse + re-login on 401)
src/fetchAvailability.js Pull availability for N days -> data/availability.csv
.env.example             Config template (copy to .env)
state/storageState.json  Saved session (gitignored)
data/availability.csv    Output, overwritten each run (gitignored)
```

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env     # then fill in the values
```

Fill `.env`:

- `SM_USER`, `SM_PASS` — SiteMinder login
- `SM_TOTP_SECRET` — base32 TOTP seed (Security → Reset MFA → "enter key manually")
- `SM_SPID` — property id (from the dashboard URL)
- For `SM_DEVICE_TRUST=confirm`: `GMAIL_USER` + `GMAIL_APP_PASSWORD`
  (a Google app password for the mailbox that receives the device email)

## Usage

```bash
# Log in and save the session (first run, or to refresh it)
node src/auth.js

# Pull availability -> data/availability.csv (logs in automatically if needed)
node src/fetchAvailability.js
```

The fetch reuses the saved session and logs in only when it has expired.

## Configuration (env)

| Variable | Default | Purpose |
|---|---|---|
| `SM_USER` / `SM_PASS` | — | SiteMinder credentials |
| `SM_TOTP_SECRET` | — | base32 TOTP seed |
| `SM_SPID` | — | property id |
| `SM_DAYS` | `365` | days ahead to pull |
| `SM_CHUNK_DAYS` | `30` | date-window size per request |
| `SM_OUT_FILE` | `data/availability.csv` | output path |
| `SM_DEVICE_TRUST` | `skip` | `skip` or `confirm` |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | — | IMAP mailbox for `confirm` mode |
| `GMAIL_FROM_HINT` / `GMAIL_SUBJECT_HINT` | `siteminder,phutholaluna` / `trusted device` | email filter |
| `SM_HEADFUL` | `false` | show the browser window |
| `SM_SLOWMO` | `0` | ms delay between actions (for watching) |
| `SM_KEEP_OPEN_MS` | `0` | keep the window open at the end (for watching) |

## Output

`data/availability.csv` — a `date` column plus one column per room-type UUID, one row
per date. Overwritten every run.

## Security

- `.env`, `data/`, and `state/storageState.json` are gitignored — credentials, the live
  session, and business data never get committed. (`state/seenReservations.json`, the
  dedupe log, is tracked on purpose so the workflow can persist it.)
- The session file holds live tokens; don't copy it anywhere public.

## Daily OTA Sales report

`node src/report.js` builds the "Báo Cáo OTA Sales" report and sends it to a Zalo
group. It pulls availability (next `SM_DAYS`) + reservations booked yesterday→now
(Vietnam time), dedupes against `state/seenReservations.json` (rolling last 100
keys), maps each OTA room back to a SiteMinder room via `roomMappings.json`, and
reports rooms sold (`bán`) and rooms left (`còn`) per room type per night, with the
booking list. Example:

```
📊 Báo Cáo OTA Sales ngày 13-10-2026:

🛏️ Deluxe Double:
📅 01–03/03 còn 0 · 04/03 còn 1 · 05–06/03 còn 2 · 07/03 còn 3 (bán 1)
📅 16–17/03 còn 0 · 18/03 còn 2 · 19/03 còn 0 (bán 1)
👤 Agoda - 1785446839 | yejun koo
   💰 2.062.937đ/đêm · 01→03/03 · tổng 4.125.874đ
...
```

- **📅 lines:** one line per run of consecutive nights; nights with the same bán/còn
  merge into an inclusive range (`01–03/03` = nights 1, 2, 3). No year. `(bán N)` at
  the end when bán is the same for the whole line, otherwise each group shows its own.
- **💰 line:** per-room nightly rate (`total ÷ rooms ÷ nights`), stay as
  check-in→check-out, and `tổng` = the **full booking total** (all rooms, all nights).
- **Cancellations** go in a separate **❌ Hủy phòng** message, sent only when there
  are any. Modifications are skipped.
- Messages are split to stay under Zalo's 2000-char limit.

Config: `SM_SPID`, `SM_DAYS`, `SM_TOPUP_ROOMS` (rooms that get a "top up" note when
`còn=0`), `ZALO_BOT_TOKEN`, `ZALO_CHAT_ID`. Device trust is `skip` (untrusted session).

## Automated schedule (GitHub Actions)

`.github/workflows/report.yml` runs `src/report.js` on manual dispatch or via an
external `repository_dispatch` (`event_type: run-report`), which **cron-job.org**
sends daily. There is no GitHub `schedule:` cron. Each run logs in fresh, retries up
to 3 times (90s apart) if SiteMinder asks for a step-up check, and commits the updated
`state/seenReservations.json` back to the repo (`chore: update dedupe log`).

Add these repository **secrets** (Settings → Secrets and variables → Actions):
`SM_USER`, `SM_PASS`, `SM_TOTP_SECRET`, `SM_SPID`, `ZALO_BOT_TOKEN`, `ZALO_CHAT_ID`.

See [DESIGN.md](DESIGN.md) for the full design.

## Not done yet

- **Rates/prices** — only availability + reservations so far; rates are a separate
  GraphQL operation to be added.
- **Modifications** — modified bookings are not reported yet.
