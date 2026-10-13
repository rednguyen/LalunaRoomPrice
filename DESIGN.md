# LalunaPriceService — Design & Architecture

How this project was built and how it works end to end. It automates access to
the hotel's **own** SiteMinder account (Laluna Hoi An Riverside Hotel) to produce
a daily Vietnamese "Báo Cáo OTA Sales" report and deliver it to a Zalo group.

- **Property (spid):** `f480c881-63c3-4a11-8d81-bba590c4bbca`
- **Stack:** Node.js + Playwright (headless Chromium) + axios
- **Runs on:** GitHub Actions (triggered daily by cron-job.org), repo `rednguyen/LalunaRoomPrice`

---

## 1. The problem

SiteMinder exposes no convenient public API for the data we need, but the web app
(`platform.siteminder.com`) does it all through internal GraphQL endpoints behind a
login. So the approach was to **reverse-engineer the web app's own login + API
calls** and reproduce them from a script — for the account owner's own data.

Everything below was discovered by inspecting the browser's Network tab / a HAR
capture of a real login, then reproduced with Playwright.

---

## 2. Authentication (the hard part)

SiteMinder login is **Auth0-based** (custom domain `auth0.siteminder.com`) with MFA
and trusted-device enrollment. The app API is **cookie-authenticated** (session
cookies on `.siteminder.com`), not bearer tokens.

### 2.1 The login flow (observed)

```
1. authx.siteminder.com/login          two-step form: email → "Next" → password
2. auth0.siteminder.com/co/authenticate credentials → login_ticket (Auth0 cross-origin)
3. auth0.siteminder.com/authorize       login_ticket → authorization code (no PKCE)
4. authx.siteminder.com/api/authenticate code → session + token (server-side exchange)
5. MFA (/mfa)                           6-digit TOTP (authenticator app)
6. trusted-device screen                "Skip" (session-only) OR confirm via email
7. lands on platform.siteminder.com/dashboard/<spid>
```

The token exchange happens **server-side**, so the browser only ever holds cookies —
which is why we drive a real browser instead of replaying HTTP by hand.

### 2.2 How the automation reproduces it (`src/auth.js`)

- **Two-step form:** fill email → click Next → fill password → submit. The page is a
  SPA, so every field is waited for (never checked once).
- **TOTP:** the `/mfa` screen is **6 separate `type=number` boxes** with **no submit
  button** — it auto-submits when filled. We generate the code with **`otplib` v12**
  (`authenticator.generate`; v13 removed that API — must pin v12) from `SM_TOTP_SECRET`,
  then type it digit-by-digit into the focused first box so the component auto-advances.
- **Trusted device** (`SM_DEVICE_TRUST`):
  - `skip` (default/production): click **"Skip"** → log in as an untrusted,
    session-only device. Verified: the untrusted session can still read availability
    **and** reservations, so this is all we need.
  - `confirm`: auto-confirm the "trusted device" email. SiteMinder mails the login
    address; the user forwards it to another Gmail that the bot reads over **IMAP**
    (`src/gmail.js`, app password). Confirmation must be done by **opening the email
    link in the browser** (`page.goto`), not a bare GET — a bare GET confirms
    server-side but doesn't advance the open login session.
- **Session capture:** on success, Playwright's `storageState` (cookies + localStorage)
  is saved to `state/storageState.json`.

### 2.3 Gotchas learned

- Site is behind **Cloudflare**; headless Playwright passes it. The **login** works from
  both residential and GitHub datacenter IPs — but from the datacenter IP the risk engine
  intermittently demands step-up on the **data** call (see §7.2).
- Never print generated TOTP codes to logs (it trips safety tooling).
- Auth0 SSO cookies expire in ~15h; the app session (`AUTH_X_TOKEN`) lasts ~30 days
  nominally, but the server can invalidate sooner — so we **reuse the saved session and
  only re-login on a 401** (`withGraphqlAuth`).

---

## 3. Data access (GraphQL)

Two internal endpoints, both authenticated the same way.

| Endpoint | Purpose |
|---|---|
| `platform.siteminder.com/api/cm-beef/graphql` | availability (`roomTypeDates`) |
| `platform.siteminder.com/api/reservations-beef/graphql` | reservations (`getReservationsSearch`) |

### 3.1 The auth recipe (`src/graphql.js`)

1. Load `state/storageState.json` into a Playwright browser context.
2. **Navigate to the dashboard once** — this makes the app set `sm_access_token` +
   `sm_xsrf_token` cookies on `platform.siteminder.com` (they are **not** in the
   login storageState until the app runs).
3. Read the **`sm_xsrf_token`** cookie and send it as header **`x-xsrf-token`** on each
   POST (cookies ride along automatically). Without it → `401 "xsrf token missing"`.

The client reuses the saved session and re-logs in once on a 401 (`withGraphqlAuth`); a
`step_up_required` 403 instead fails fast so the outer retry can start fresh (see §7.2).

### 3.2 Availability — `roomTypeDates`

Returns `{ roomTypeUuid, date, available }` per room-type per date. The date range is
**chunked** (default 30 days/request) and recombined; SiteMinder also accepts a full
year in one request, but chunking is more robust. `SM_DAYS` controls the horizon (450
in production, so stays up to ~15 months out still have availability).

### 3.3 Reservations — `getReservationsSearch`

Two passes over the same operation (paginated, 100/page):
- **New bookings:** filter `bookedOnDateRange` (when booked), sort `bookedOnDate`.
- **Cancellations:** filter `bookingCancelledDateRange` + `bookingStatus: ["Cancellation"]`,
  sort `cancelledOnDate` — by **cancellation date**, so it catches bookings cancelled now
  **regardless of when they were booked**.

Each record has `channel`, `fromDate`/`checkOutDate`, `currency`, `totalAmount`, `roomStays[]`
(each with a channel-specific `roomName`), `mainGuest`, `canceledAt`, `modifiedAt`, and `type`
(`Reservation` / `Modification` / `Cancellation`).

> Gotcha: the server returns a generic `"Server error"` for **unknown filter fields** (it
> masks validation errors), so filter names can't be discovered by probing — they must be
> read off the app's own DevTools requests (that's how `bookingCancelledDateRange` was found).

---

## 4. Room mapping (`roomMappings.json`)

The hotel's 10 SiteMinder rooms each have a **different name on each channel**. Reservations
arrive with the **OTA's** room name (plus a rate-plan suffix), so to group bookings by
SiteMinder room we map back.

- `roomTypes.json` — SiteMinder room `uuid → name` (used to join availability).
- `roomMappings.json` — `SiteMinder name → { channel → OTA room name }`, hardcoded for
  all 6 OTAs (**Booking.com, Agoda, Expedia, Trip.com, OhMyHotel, Traveloka**) plus
  **Direct Booking**.

**Reverse lookup** (reservation → SiteMinder room): take the reservation's `channel.name`
+ `roomStays[].roomName`; the OTA name sits at the **front** of `roomName` (before the
` - <rate plan>` suffix), so we match the mapping whose value is the longest prefix of
`roomName`. One reservation can have multiple `roomStays` of different types (each counts
as one room).

> Note: OTA reservation room names can differ from the content-mapping screen names
> (e.g. Booking.com sends "Deluxe King Room with Balcony", not "Deluxe Double Room with
> Pool View"), so the mapping values were set to the **reservation** names.

---

## 5. The daily report (`src/report.js`)

Produces the "Báo Cáo OTA Sales" report. All dates/times are **Asia/Ho_Chi_Minh (UTC+7)**.

**Steps:**
1. **Availability** — pull `roomTypeDates` for the next `SM_DAYS` days → the `còn`
   (rooms remaining) source. Held in memory only (a live snapshot; never written to disk).
2. **Bookings** — pull reservations made **yesterday 00:00 → today 23:59:59 (VN)**. Dedupe
   against `state/seenReservations.json` (**rolling last 100** keys) so each reports once;
   unmapped bookings are **not** consumed (they retry once their mapping exists).
   `Modification` records are skipped; `Cancellation` records are handled in step 4.
3. **Aggregate** — for each booking's `roomStays`, map to a SiteMinder room; the stay occupies
   nights `fromDate → checkOutDate` (exclusive), counting **only nights from today onward**.
   `bán` per night = rooms sold; `còn` = the availability snapshot.
4. **Cancellations** — pull via the cancellation query (step above) and list each in a separate
   **❌ Hủy phòng** message. Deduped under a distinct `<sourceId>|C` key (so a cancellation
   reports once, independent of its original booking, in the same log file).

**Output** — two independent messages (each chunked under Zalo's 2000-char limit), sections
ordered by `roomMappings.json` and separated by a dashed line.

Message 1 — **bookings** (always sent):
```
📊 Báo Cáo OTA Sales ngày 12-10-2026:

🛏️ Superior Double:
📅 Ngày 24-10-2026: bán 1 | còn 2
👤 Booking.com - 6010480449 | Lydia Mawdsley
   💰 1.491.950đ/đêm · 24→26/10 · tổng 2.983.900đ
----------------------------------------
🛏️ Deluxe Double:
...
```
Each booking's 2nd line is the **per-room nightly rate** (`total ÷ rooms ÷ nights`), the
**stay range** (check-in → check-out), and the **full booking total** (all rooms, all nights —
`totalAmount.amountAfterTax`).

Message 2 — **cancellations** (sent only when there are any):
```
❌ Hủy phòng ngày 12-10-2026:

👤 Booking.com - 5280356445 | Zhang Yucheng
   🛏️ Family Pool View (DLX) · 19→21/08 · 💰 11.375.316đ
```

- **Top-up nudge:** for rooms listed in `SM_TOPUP_ROOMS`, a `còn = 0` night gets
  `---> sales cân nhắc top up`. **Disabled by default** (empty); set e.g.
  `SM_TOPUP_ROOMS="Superior Double,Deluxe Double"` to enable.
- If nothing new: `✅ Không có booking mới nào đến thời điểm hiện tại.`

---

## 6. Zalo delivery (`src/zalo.js`)

Sends via the Zalo Bot API: `POST https://bot-api.zaloplatforms.com/bot<TOKEN>/sendMessage`
with `{ chat_id, text }` (axios), configured by `ZALO_BOT_TOKEN` + `ZALO_CHAT_ID`.

- **Bookings and cancellations are two independent reports** (two `sendToZalo` calls); the
  cancellations report is only sent when there are cancellations.
- **Zalo caps messages at ~2000 chars**, so each report is split into multiple messages,
  **never splitting a section** (packed on section boundaries; a single oversized section
  falls back to line-splitting). The **title appears on the first message only** of each report.
- If the token/chat id aren't set, it prints the report instead (so the pipeline is
  testable without sending).

---

## 7. Deployment (GitHub Actions)

`.github/workflows/report.yml` runs `src/report.js` on an ephemeral `ubuntu-latest` runner.

- **Triggers:** manual `workflow_dispatch`, and external `repository_dispatch`
  (`event_type: run-report`). GitHub's own `schedule:` cron was **removed** — scheduling is
  driven by **cron-job.org**, which POSTs daily (in Asia/Ho_Chi_Minh) to
  `https://api.github.com/repos/<owner>/<repo>/dispatches` with body
  `{"event_type":"run-report"}`. That request uses a GitHub **fine-grained token** with
  **Contents: Read and write** (stored in cron-job.org). A successful trigger returns HTTP
  204. Trade-off: fine-grained tokens expire within 1 year and must be rotated (GitHub
  emails a reminder); GitHub's native cron needs no token but is UTC-only.
- **Steps:** checkout → setup Node 20 → `npm ci` → `npx playwright install --with-deps
  chromium` → run report (with retry, below) → commit the dedupe log back.
- **Secrets** (Settings → Secrets and variables → Actions): `SM_USER`, `SM_PASS`,
  `SM_TOTP_SECRET`, `SM_SPID`, `ZALO_BOT_TOKEN`, `ZALO_CHAT_ID`. Non-secret config
  (`SM_DAYS=450`, `SM_DEVICE_TRUST=skip`, `SM_HEADFUL=false`) is set in the workflow env.
- **Workflow permissions:** the job declares `permissions: contents: write`, and the repo
  must be set to **Settings → Actions → General → Workflow permissions → "Read and write"**
  so the dedupe commit-back can push.

The runner logs in fresh each run (ephemeral, no persisted session). Because device trust
is `skip`, SiteMinder emails a "new device" notice each run (harmless, ignored).

### 7.1 Dedupe persistence (repo-tracked)

`state/seenReservations.json` is **tracked in the repo** (a negation in `.gitignore`;
`storageState.json` stays ignored). Each run reads it, updates it, and a final step
**commits it back** (`chore: update dedupe log [skip ci]`). This replaced an earlier
`actions/cache` approach so the log can be **viewed and edited directly** in the repo —
empty it (`{"sourceIds":[]}`) to force a full re-report, or remove specific IDs to
re-report just those.

### 7.2 Intermittent `step_up_required` and auto-retry

From GitHub's **datacenter IP** with an untrusted (`skip`) session, SiteMinder's risk
engine **intermittently** returns `403 {"code":"step_up_required"}` on the data call —
even though the **login itself succeeds**. It never happens from a residential IP, which
is why it only surfaced on Actions. Handling:

- **`graphql.js`** — a `step_up_required` 403 **throws and exits** instead of attempting an
  in-process re-login. (A re-login can't clear step-up, and a second TOTP within the same
  30-second window is rejected → a `/mfa` timeout.) Genuine session-expiry 401s still
  re-login once.
- **workflow** — the run step retries up to **3 times, 90s apart**, deleting
  `state/storageState.json` before each attempt so every try is a **fresh login** (new
  session + a new TOTP code). Because the step-up is intermittent, one attempt usually
  clears it — no manual re-run.

If step-up ever becomes **persistent** (all 3 attempts fail), the fix is a **self-hosted
runner** on a residential/stable IP, where `skip` mode always works.

---

## 8. Security

- `.env`, `data/`, and `state/storageState.json` are **gitignored** — credentials, business
  data, and the live session never get committed. (`state/seenReservations.json`, the dedupe
  log, is tracked on purpose — see §7.1.)
- Keep the GitHub repo **private**; it drives the account and references secrets.
- The automated path uses `SM_DEVICE_TRUST=skip`, so both factors (password + TOTP seed)
  live in GitHub secrets; MFA no longer adds protection for that path — an accepted
  trade-off for an unattended job on the owner's own account.

---

## 9. File map

```
src/auth.js              Automated login + session capture (TOTP, trusted-device modes)
src/gmail.js             IMAP reader for the trusted-device email (confirm mode only)
src/graphql.js           Authenticated GraphQL client (session reuse + re-login on 401)
src/report.js            The daily OTA sales report (availability + reservations)
src/fetchAvailability.js Standalone availability → data/availability.csv exporter
src/zalo.js              Zalo Bot API sender + 2000-char section-aware splitting
roomTypes.json           SiteMinder room uuid → name
roomMappings.json        SiteMinder name → per-channel OTA room name (6 OTAs + Direct)
.github/workflows/report.yml  Daily Actions workflow
.env.example             Config template
```

---

## 10. Configuration reference

| Var | Default | Purpose |
|---|---|---|
| `SM_USER` / `SM_PASS` | — | SiteMinder credentials |
| `SM_TOTP_SECRET` | — | base32 TOTP seed |
| `SM_SPID` | — | property id |
| `SM_DAYS` | 365 (450 in prod) | availability horizon (days) |
| `SM_CHUNK_DAYS` | 30 | availability request window size |
| `SM_DEVICE_TRUST` | skip | `skip` or `confirm` (Gmail) |
| `SM_TOPUP_ROOMS` | (empty = disabled) | rooms that get the top-up note at `còn=0` |
| `SM_HEADFUL` / `SM_SLOWMO` / `SM_KEEP_OPEN_MS` | false / 0 / 0 | debugging (watch the browser) |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | — | IMAP mailbox for `confirm` mode |
| `ZALO_BOT_TOKEN` / `ZALO_CHAT_ID` | — | Zalo delivery |
| `ZALO_MAX_LEN` | 2000 | max chars per Zalo message |

---

## 11. Known limitations / future work

- **Rates/prices** — only availability + reservations are pulled; rates are a separate
  GraphQL operation to add.
- **Modifications** — `Modification` records are still skipped (only new bookings and
  cancellations are reported).
- **Old/renamed room names** — a booking made long ago (surfaced via a cancellation) may
  carry an outdated OTA room name that no longer prefix-matches `roomMappings.json`; it then
  shows the raw channel name instead of the SiteMinder name. (Could be fixed with multiple
  name variants per channel.)
- **Multi-message marker** — an optional `(1/N)` indicator on split reports.
- **Datacenter-IP step-up** — handled by the auto-retry (§7.2); a *persistent* occurrence
  would require a self-hosted runner (residential IP). Each fresh login also triggers a
  "new device" email (skip mode).
