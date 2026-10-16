// Daily "Báo Cáo OTA Sales" report.
//
// Step 1: availability (roomTypeDates) for the next N days  -> "còn" source.
// Step 2: reservations booked yesterday->now (Asia/Ho_Chi_Minh), deduped by
//         sourceId (rolling last 100). A booking reports once; later modifications of an
//         already-reported booking are skipped by the dedupe (seen) check.
// Step 3: cancellations (by cancellation date), deduped as "<sourceId>|C".
//         New Booking.com cancellations: reveal the guest's relay email and send the
//         feedback email (cancellationEmail.txt) — see GUEST_EMAIL_MODE below.
// Then aggregate rooms sold per SiteMinder room type per stay-night, format the
// bookings report (+ a separate cancellations report) and hand them to Zalo.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { withGraphqlAuth, SPID } = require("./graphql");
const { sendToZalo } = require("./zalo");
const { revealGuestEmail } = require("./siteminderGuest");
const gmail = require("./gmailSend");

// Cancellation feedback emails (Booking.com only for now). Needs the trusted SiteMinder
// browser profile (SM_PROFILE_DIR) to reveal emails; without it the feature is inactive
// and the report is unchanged.
//   off = never   ·   dry-run (default) = reveal + build the email, don't send   ·   live = send
const GUEST_EMAIL_MODE = (process.env.GUEST_EMAIL_MODE || "dry-run").toLowerCase();
const GUEST_EMAIL_ACTIVE = !!process.env.SM_PROFILE_DIR && GUEST_EMAIL_MODE !== "off";
// REPORT_NO_SAVE=true (the workflow's "Post to Zalo: no"): a test run that prints the reports
// and doesn't mark anything as reported, so the next real run still posts it all to Zalo.
// (Emailed guests are still logged — they really were emailed.)
const SAVE_SEEN = String(process.env.REPORT_NO_SAVE).toLowerCase() !== "true";
const EMAILED_FILE = process.env.GUEST_EMAIL_LOG || "state/emailedGuests.json";
const isBookingCom = (r) => /booking\.?com/i.test(r.channel && r.channel.name);
// Extra line under a cancellation whose guest was emailed (the email lands in the
// reservation's extranet conversation). Not-emailed ones get nothing.
const EMAILED_NOTE = "\n   ✉️ Đã hỏi thăm khách trên Extranet";

const CM_URL = "https://platform.siteminder.com/api/cm-beef/graphql";
const RES_URL = "https://platform.siteminder.com/api/reservations-beef/graphql";
const SEEN_FILE = process.env.SM_SEEN_FILE || "state/seenReservations.json";
const SEEN_CAP = 100;
const AVAIL_DAYS = Number(process.env.SM_DAYS || 365);

const roomTypes = JSON.parse(fs.readFileSync("roomTypes.json", "utf8")); // [{uuid,name}]
const roomMappings = JSON.parse(fs.readFileSync("roomMappings.json", "utf8")); // {smName:{channel:otaName}}
const uuidByName = new Map(roomTypes.map((r) => [r.name, r.uuid]));
const CHANNEL_KEYS = [...new Set(Object.values(roomMappings).flatMap((c) => Object.keys(c)))];
// Rooms that get a "top up" nudge when availability hits 0 on a sold night.
// Disabled by default; set SM_TOPUP_ROOMS (e.g. "Superior Double,Deluxe Double") to enable.
const TOP_UP_ROOMS = new Set(
  (process.env.SM_TOPUP_ROOMS || "").split(",").map((s) => s.trim()).filter(Boolean)
);

const AVAIL_QUERY = `query roomTypeDates($spid: ID!, $roomTypeUuids: [ID!]!, $dates: [LocalDate!]!, $isCmInventoryGridFeatureEnabled: Boolean!) {
  roomTypeDates(spid: $spid, roomTypeUuids: $roomTypeUuids, dates: $dates) @include(if: $isCmInventoryGridFeatureEnabled) {
    roomTypeUuid available date __typename
  }
}`;

const RES_QUERY = `query getReservationsSearch($spid: ID!, $filters: PlatformReservationsFilterInput, $pagination: PlatformReservationsPaginationInput) {
  hotel(spid: $spid) {
    platformReservations(filters: $filters, pagination: $pagination) {
      results {
        uuid sourceId smPlatformReservationId
        channel { code name __typename }
        fromDate toDate checkOutDate canceledAt modifiedAt channelCreatedAt
        currency
        totalAmount { amountAfterTax amountBeforeTax __typename }
        roomStays { roomName __typename }
        mainGuest { firstName middleName lastName __typename }
        __typename
      }
      page pageSize total __typename
    }
    __typename
  }
}`;

// ---- Vietnam (UTC+7, no DST) date helpers ----
function vnYMD(d = new Date()) {
  const v = new Date(d.getTime() + 7 * 3600 * 1000);
  return { y: v.getUTCFullYear(), m: v.getUTCMonth() + 1, d: v.getUTCDate() };
}
const iso = ({ y, m, d }) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const ddmmyyyy = (ymd) => { const [y, m, d] = ymd.split("-"); return `${d}-${m}-${y}`; };

function addDaysISO(baseISO, n) {
  const [y, m, d] = baseISO.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * 86400000).toISOString().slice(0, 10);
}
// nights occupied by a stay: [fromDate, checkOut) exclusive
function nights(fromDate, checkOut) {
  const out = [];
  for (let cur = fromDate; cur < checkOut; cur = addDaysISO(cur, 1)) out.push(cur);
  return out;
}
// Format money VN-style (1500000 -> "1.500.000đ"); non-VND keeps the currency code.
function fmtMoney(n, currency) {
  const amt = String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return (currency || "VND") === "VND" ? `${amt}đ` : `${amt} ${currency}`;
}
// Stay as check-in → check-out, e.g. "05→09/02" (same month) or "28/01→02/02".
function stayRange(fromISO, checkOutISO) {
  const [fy, fm, fd] = fromISO.split("-");
  const [ty, tm, td] = checkOutISO.split("-");
  return fm === tm && fy === ty ? `${fd}→${td}/${fm}` : `${fd}/${fm}→${td}/${tm}`;
}

// Compact night lines: one line per run of consecutive nights; within a run, adjacent
// nights with the same bán/còn merge into an inclusive range ("01–03/03"). If bán is the
// same across the run it's written once at the end, e.g.
//   "01–03/03 còn 0 · 04/03 còn 1 (bán 1)"   else   "14/12 bán 1 còn 2 · 15/12 bán 2 còn 0"
function nightLines(soldByDate, availFor) {
  const short = (d) => `${d.slice(8)}/${d.slice(5, 7)}`;
  const span = (a, b) => a === b ? short(a)
    : a.slice(0, 7) === b.slice(0, 7) ? `${a.slice(8)}–${short(b)}` : `${short(a)}–${short(b)}`;
  const runs = [];
  for (const date of [...soldByDate.keys()].sort()) {
    const sold = soldByDate.get(date);
    const left = availFor(date);
    const run = runs[runs.length - 1];
    const g = run && run.groups[run.groups.length - 1];
    if (!run || addDaysISO(g.to, 1) !== date) runs.push({ groups: [{ from: date, to: date, sold, left }] });
    else if (g.sold === sold && g.left === left) g.to = date;
    else run.groups.push({ from: date, to: date, sold, left });
  }
  return runs.map(({ groups }) => {
    const oneSold = groups.every((g) => g.sold === groups[0].sold);
    const parts = groups.map((g) =>
      `${span(g.from, g.to)}${oneSold ? "" : ` bán ${g.sold}`} còn ${g.left === undefined ? "?" : g.left}`);
    return {
      text: parts.join(" · ") + (oneSold ? ` (bán ${groups[0].sold})` : ""),
      hasZero: groups.some((g) => g.left === 0),
    };
  });
}

// ---- mapping: channel.name + roomName -> SiteMinder room type ----
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
function resolveChannelKey(channelName) {
  const n = norm(channelName);
  return CHANNEL_KEYS.find((k) => n.startsWith(norm(k)) || norm(k).startsWith(n)) || null;
}
function resolveRoomType(channelKey, roomName) {
  if (!channelKey || !roomName) return null;
  let best = null, bestLen = -1;
  for (const [smName, ch] of Object.entries(roomMappings)) {
    const ota = ch[channelKey];
    if (ota && roomName.startsWith(ota) && ota.length > bestLen) { best = smName; bestLen = ota.length; }
  }
  return best;
}

// ---- seen-sourceId store (rolling last 100) ----
function loadSeen() {
  try { return JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")).sourceIds || []; } catch { return []; }
}
function saveSeen(ids) {
  fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
  fs.writeFileSync(SEEN_FILE, JSON.stringify({ sourceIds: ids.slice(-SEEN_CAP) }, null, 2) + "\n");
}

// ---- guests already emailed (never email anyone twice, even across workflow retries) ----
function loadEmailed() {
  try { return JSON.parse(fs.readFileSync(EMAILED_FILE, "utf8")).sent || []; } catch { return []; }
}
function logEmailed(sourceId) {
  const sent = loadEmailed();
  sent.push({ sourceId, at: new Date().toISOString() });
  fs.mkdirSync(path.dirname(EMAILED_FILE), { recursive: true });
  fs.writeFileSync(EMAILED_FILE, JSON.stringify({ sent: sent.slice(-500) }, null, 2) + "\n");
}
const maskEmail = (e) => `${e.slice(0, 2)}***@${e.split("@")[1]}`;

async function fetchAvailability(run, startISO, count = AVAIL_DAYS) {
  const dates = [];
  for (let i = 0; i < count; i++) dates.push(addDaysISO(startISO, i));
  const uuids = roomTypes.map((r) => r.uuid);
  const avail = new Map();
  const CHUNK = Number(process.env.SM_CHUNK_DAYS || 30);
  for (let i = 0; i < dates.length; i += CHUNK) {
    const chunk = dates.slice(i, i + CHUNK);
    const data = await run("roomTypeDates", AVAIL_QUERY,
      { spid: SPID, roomTypeUuids: uuids, dates: chunk, isCmInventoryGridFeatureEnabled: true }, CM_URL);
    for (const r of (data?.roomTypeDates || [])) avail.set(`${r.roomTypeUuid}|${r.date}`, r.available);
  }
  return avail;
}

// Paginate getReservationsSearch with the given filters/sort.
async function fetchAll(run, filters, sortBy) {
  const out = [];
  let page = 1; const pageSize = 100; let total = Infinity;
  while ((page - 1) * pageSize < total) {
    const data = await run("getReservationsSearch", RES_QUERY, {
      spid: SPID, filters,
      pagination: { page, pageSize, sortBy, sortOrder: "asc" },
    }, RES_URL);
    const pr = data?.hotel?.platformReservations;
    if (!pr) break;
    total = pr.total;
    out.push(...(pr.results || []));
    if (!pr.results || pr.results.length < pageSize) break;
    page++;
  }
  return out;
}
// New bookings: filter by when the booking was made.
const fetchReservations = (run, startVN, endVN) =>
  fetchAll(run, { bookedOnDateRange: { startDate: startVN, endDate: endVN } }, "bookedOnDate");
// Cancellations: filter by when it was cancelled (catches old bookings cancelled now).
const fetchCancellations = (run, startVN, endVN) =>
  fetchAll(run, { bookingCancelledDateRange: { startDate: startVN, endDate: endVN }, bookingStatus: ["Cancellation"] }, "cancelledOnDate");

function guestName(g) {
  if (!g) return "";
  return [g.firstName, g.lastName].filter(Boolean).join(" ").trim();
}

(async () => {
  if (!SPID) throw new Error("SM_SPID is not set in .env");

  const today = vnYMD();
  const todayISO = iso(today);
  const yesterdayISO = addDaysISO(todayISO, -1);
  const bookedStart = `${yesterdayISO}T00:00:00+07:00`;
  const bookedEnd = `${todayISO}T23:59:59+07:00`;

  const seen = loadSeen();
  const seenSet = new Set(seen);

  const emailedSet = new Set(loadEmailed().map((e) => e.sourceId));

  const { avail, reservations, cancelled, guests } = await withGraphqlAuth(async (run, page) => {
    const avail = await fetchAvailability(run, todayISO);
    const reservations = await fetchReservations(run, bookedStart, bookedEnd);
    const cancelled = await fetchCancellations(run, bookedStart, bookedEnd);
    // Reveal emails while the trusted browser is open (one trusted-device check each).
    // guests: sourceId -> { email, firstName, lastName } | { error }
    const guests = new Map();
    if (GUEST_EMAIL_ACTIVE) {
      for (const r of cancelled) {
        if (!isBookingCom(r) || seenSet.has(`${r.sourceId}|C`) || emailedSet.has(r.sourceId)) continue;
        try { guests.set(r.sourceId, await revealGuestEmail(run, page, SPID, r.smPlatformReservationId)); }
        catch (e) { guests.set(r.sourceId, { error: e.message }); }
      }
    }
    return { avail, reservations, cancelled, guests };
  });

  console.log(`Fetched: availability ${avail.size} cells, reservations ${reservations.length}, cancellations ${cancelled.length} in window ${yesterdayISO}..${todayISO} (VN)`);

  // perRoom: smName -> { nights: Map(date->count), bookings: Map(sourceId->line) }
  const perRoom = new Map();
  const unmapped = [];
  const newSourceIds = [];   // bookings consumed by this run
  const newCancelKeys = [];  // "<sourceId>|C" keys consumed by this run
  const cancellations = [];

  for (const r of reservations) {
    const checkOut = r.checkOutDate || r.toDate;
    const chKey = resolveChannelKey(r.channel && r.channel.name);
    // Cancellations come from the dedicated cancellation query (processed below) — skip here.
    if (r.type === "Cancellation" || r.canceledAt) continue;

    // ---- new booking ----
    if (seenSet.has(r.sourceId)) continue;        // already handled in a prior run
    // (Don't skip on modifiedAt: a new booking modified the same day still has it set, and
    // skipping dropped a real new booking. Modifications of already-reported bookings are
    // already caught by the seenSet check above, so they don't re-report.)
    if (!r.fromDate || !checkOut) { newSourceIds.push(r.sourceId); continue; }
    const allNights = nights(r.fromDate, checkOut);
    // Only report nights from today onward (skip yesterday/past nights).
    const stayNights = allNights.filter((n) => n >= todayISO);

    // Nightly rate is per room (total / #rooms / #nights); "tổng" is the full booking total.
    const numNights = allNights.length || 1;
    const numRooms = (r.roomStays || []).length || 1;
    const amt = r.totalAmount && r.totalAmount.amountAfterTax;
    const priceLine = amt != null
      ? `\n   💰 ${fmtMoney(amt / numRooms / numNights, r.currency)}/đêm · ${stayRange(r.fromDate, checkOut)} · tổng ${fmtMoney(amt, r.currency)}`
      : "";

    let mappedAny = false;
    for (const rs of (r.roomStays || [])) {
      const smRoom = resolveRoomType(chKey, rs.roomName);
      if (!smRoom) { unmapped.push({ sourceId: r.sourceId, channel: r.channel && r.channel.name, roomName: rs.roomName }); continue; }
      mappedAny = true;                 // handled even if the stay has no nights today onward
      if (stayNights.length === 0) continue;
      if (!perRoom.has(smRoom)) perRoom.set(smRoom, { nights: new Map(), bookings: new Map() });
      const bucket = perRoom.get(smRoom);
      for (const night of stayNights) bucket.nights.set(night, (bucket.nights.get(night) || 0) + 1);
      bucket.bookings.set(r.sourceId, `👤 ${r.channel && r.channel.name} - ${r.sourceId} | ${guestName(r.mainGuest)}${priceLine}`);
    }
    // Only consume reservations we actually reported; leave fully-unmapped ones
    // unseen so they retry once their channel/room mapping is added.
    if (mappedAny) newSourceIds.push(r.sourceId);
  }

  // ---- cancellations (by cancellation date; includes bookings made outside the window) ----
  // Same sourceId as the original booking, so dedupe under a distinct "|C" key.
  for (const r of cancelled) {
    const ckey = `${r.sourceId}|C`;
    if (seenSet.has(ckey)) continue;
    newCancelKeys.push(ckey);
    const chKey = resolveChannelKey(r.channel && r.channel.name);
    const checkOut = r.checkOutDate || r.toDate;
    const rooms = [...new Set((r.roomStays || []).map((rs) => resolveRoomType(chKey, rs.roomName) || rs.roomName))];
    const total = r.totalAmount && r.totalAmount.amountAfterTax;
    const when = r.fromDate && checkOut ? stayRange(r.fromDate, checkOut) : "?";
    cancellations.push({
      sourceId: r.sourceId,
      emailed: GUEST_EMAIL_ACTIVE && isBookingCom(r),   // guest gets the feedback email
      text: `👤 ${r.channel && r.channel.name} - ${r.sourceId} | ${guestName(r.mainGuest)}\n` +
        `   🛏️ ${rooms.join(", ") || "(?)"} · ${when}${total != null ? ` · 💰 ${fmtMoney(total, r.currency)}` : ""}`,
    });
  }

  // ---- build report text ----
  const title = `📊 Báo Cáo OTA Sales ngày ${ddmmyyyy(todayISO)}:`;
  // Section order follows the key order in roomMappings.json.
  const roomOrder = Object.keys(roomMappings).filter((n) => perRoom.has(n));
  const SEP = "----------------------------------------";

  const sections = roomOrder.map((smName) => {
    const bucket = perRoom.get(smName);
    const uuid = uuidByName.get(smName);
    const sec = [`🛏️ ${smName}:`];
    for (const run of nightLines(bucket.nights, (date) => avail.get(`${uuid}|${date}`))) {
      let line = `📅 ${run.text}`;
      if (run.hasZero && TOP_UP_ROOMS.has(smName)) line += " -> sales cân nhắc top up";
      sec.push(line);
    }
    for (const line of bucket.bookings.values()) sec.push(line);
    return sec.join("\n");
  });
  const bookingReport = sections.length === 0
    ? `${title}\n\n✅ Không có booking mới nào đến thời điểm hiện tại.`
    : `${title}\n\n` + sections.join(`\n${SEP}\n`);

  if (unmapped.length) {
    console.log(`\n⚠️ ${unmapped.length} unmapped room stay(s):`);
    for (const u of unmapped) console.log(`   [${u.channel}] ${u.roomName}  (src ${u.sourceId})`);
  }

  // Send FIRST, then persist seen (rolling 100): IDs are only marked reported once their
  // report reached Zalo, so a failed send exits non-zero and the workflow retry re-sends
  // it instead of the bookings being silently lost. Each report is persisted on its own,
  // so a cancellations failure doesn't re-send an already-delivered bookings report.
  // ("not-configured" = local run that just prints the report; treated as delivered.)
  const delivered = (res) => res.sent || res.reason === "not-configured";

  console.log("\n===== BOOKINGS =====\n" + bookingReport + "\n");
  if (!delivered(await sendToZalo(bookingReport))) throw new Error("Zalo send failed (bookings) — not marked as reported; will retry.");
  if (SAVE_SEEN && newSourceIds.length) { seen.push(...newSourceIds); saveSeen(seen); }

  // Email the Booking.com guests BEFORE the cancellations report, so each line can say
  // whether it went out. A failure never blocks the report — it becomes a ⚠️ line.
  const emailStatus = new Map();   // sourceId -> "sent" | "dry-run" | "failed"
  for (const c of cancellations.filter((x) => x.emailed)) {
    if (emailedSet.has(c.sourceId)) { emailStatus.set(c.sourceId, "sent"); continue; }   // earlier attempt of this run
    const g = guests.get(c.sourceId);
    if (!g || g.error) {
      console.log(`✉️ ${c.sourceId}: couldn't get the guest email — ${g ? g.error : "not revealed"}`);
      emailStatus.set(c.sourceId, "failed"); continue;
    }
    const name = `${g.firstName} ${g.lastName}`.trim() || "Guest";
    if (GUEST_EMAIL_MODE !== "live") {
      console.log(`✉️ [dry-run] ${c.sourceId}: would email ${maskEmail(g.email)} (Dear ${name})`);
      emailStatus.set(c.sourceId, "dry-run"); continue;
    }
    try {
      // GUEST_EMAIL_TEST_TO: end-to-end test — the email goes to that address instead of the
      // guest, and isn't logged as sent (so the real guest can still be emailed later).
      const testTo = process.env.GUEST_EMAIL_TEST_TO;
      await gmail.sendEmail({ to: testTo || g.email, ...gmail.renderTemplate({ guestName: name }) });
      if (!testTo) logEmailed(c.sourceId);
      console.log(`✉️ ${c.sourceId}: emailed ${testTo ? `TEST ADDRESS instead of ${maskEmail(g.email)}` : maskEmail(g.email)}`);
      emailStatus.set(c.sourceId, "sent");
    } catch (e) {
      console.log(`✉️ ${c.sourceId}: ${e.message}`);
      emailStatus.set(c.sourceId, "failed");
    }
  }

  // Cancellations are a SEPARATE message, sent only when there are any.
  const cancelReport = cancellations.length
    ? `❌ Hủy phòng ngày ${ddmmyyyy(todayISO)}:\n\n` + cancellations.map((c) =>
        // Only a guest that was actually emailed gets a note; anything else stays silent.
        emailStatus.get(c.sourceId) === "sent" ? `${c.text}${EMAILED_NOTE}` : c.text
      ).join(`\n${SEP}\n`)
    : null;

  if (cancelReport) {
    console.log("\n===== CANCELLATIONS =====\n" + cancelReport + "\n");
    if (!delivered(await sendToZalo(cancelReport))) throw new Error("Zalo send failed (cancellations) — not marked as reported; will retry.");
  }
  if (SAVE_SEEN && newCancelKeys.length) { seen.push(...newCancelKeys); saveSeen(seen); }
})().catch((e) => {
  console.error("❌", e.message);
  // Exit 3 = SiteMinder wants step-up auth. Retrying only adds logins (and risks a lock),
  // so the workflow doesn't retry on it.
  process.exit(/step_up_required/.test(e.message) ? 3 : 1);
});
