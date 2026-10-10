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

- `.env`, `state/`, and `data/` are gitignored — credentials, the live session, and
  business data never get committed.
- The session file holds live tokens; don't copy it anywhere public.

## Not done yet

- **Rates/prices** — only availability is pulled so far; rates are a separate GraphQL
  operation to be added.
- **Scheduling** — no scheduler yet (GitHub Actions or a persistent host TBD). On
  ephemeral runners the session can't persist, so each run logs in afresh.
