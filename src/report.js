// Daily "Báo Cáo OTA Sales" report.
//
// Step 1: availability (roomTypeDates) for the next N days  -> "còn" source.
// Step 2: reservations booked yesterday->now (Asia/Ho_Chi_Minh), deduped by
//         sourceId (rolling last 100). Skip cancelled/modified for now.
// Then aggregate rooms sold per SiteMinder room type per stay-night and format
// the report, and hand it to the Zalo sender.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { withGraphqlAuth, SPID } = require("./graphql");
const { sendToZalo } = require("./zalo");

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
        uuid sourceId
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

async function fetchReservations(run, startVN, endVN) {
  const out = [];
  let page = 1; const pageSize = 100; let total = Infinity;
  while ((page - 1) * pageSize < total) {
    const data = await run("getReservationsSearch", RES_QUERY, {
      spid: SPID,
      filters: { bookedOnDateRange: { startDate: startVN, endDate: endVN } },
      pagination: { page, pageSize, sortBy: "bookedOnDate", sortOrder: "asc" },
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

  const { avail, reservations } = await withGraphqlAuth(async (run) => {
    const avail = await fetchAvailability(run, todayISO);
    const reservations = await fetchReservations(run, bookedStart, bookedEnd);
    return { avail, reservations };
  });

  console.log(`Fetched: availability ${avail.size} cells, reservations ${reservations.length} in window ${yesterdayISO}..${todayISO} (VN)`);

  // perRoom: smName -> { nights: Map(date->count), bookings: Map(sourceId->line) }
  const perRoom = new Map();
  const unmapped = [];
  const newSourceIds = [];

  for (const r of reservations) {
    if (seenSet.has(r.sourceId)) continue;       // already handled in a prior run
    if (r.canceledAt || r.modifiedAt) { newSourceIds.push(r.sourceId); continue; } // skip (consume)

    const checkOut = r.checkOutDate || r.toDate;
    if (!r.fromDate || !checkOut) { newSourceIds.push(r.sourceId); continue; }
    const allNights = nights(r.fromDate, checkOut);
    // Only report nights from today onward (skip yesterday/past nights).
    const stayNights = allNights.filter((n) => n >= todayISO);
    const chKey = resolveChannelKey(r.channel && r.channel.name);

    // Per-room nightly rate = reservation total / #rooms / #nights (full stay).
    const numNights = allNights.length || 1;
    const numRooms = (r.roomStays || []).length || 1;
    const amt = r.totalAmount && r.totalAmount.amountAfterTax;
    const priceLabel = amt != null
      ? ` | 💰 ${fmtMoney(amt / numRooms / numNights, r.currency)}/đêm (${numNights} đêm)`
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
      bucket.bookings.set(r.sourceId, `👤 ${r.channel && r.channel.name} ID - ${r.sourceId}: ${guestName(r.mainGuest)}${priceLabel}`);
    }
    // Only consume reservations we actually reported; leave fully-unmapped ones
    // unseen so they retry once their channel/room mapping is added.
    if (mappedAny) newSourceIds.push(r.sourceId);
  }

  // ---- build report text ----
  const title = `📊 Báo Cáo OTA Sales ngày ${ddmmyyyy(todayISO)}:`;
  // Section order follows the key order in roomMappings.json.
  const roomOrder = Object.keys(roomMappings).filter((n) => perRoom.has(n));
  const SEP = "----------------------------------------";

  let report;
  if (roomOrder.length === 0) {
    report = `${title}\n\n✅ Không có booking mới nào đến thời điểm hiện tại.`;
  } else {
    const sections = roomOrder.map((smName) => {
      const bucket = perRoom.get(smName);
      const uuid = uuidByName.get(smName);
      const sec = [`🛏️ ${smName}:`];
      for (const date of [...bucket.nights.keys()].sort()) {
        const sold = bucket.nights.get(date);
        const left = avail.get(`${uuid}|${date}`);
        let line = `📅 Ngày ${ddmmyyyy(date)}: bán ${sold} | còn ${left === undefined ? "?" : left}`;
        if (left === 0 && TOP_UP_ROOMS.has(smName)) line += " -> sales cân nhắc top up";
        sec.push(line);
      }
      for (const line of bucket.bookings.values()) sec.push(line);
      return sec.join("\n");
    });
    report = `${title}\n\n` + sections.join(`\n${SEP}\n`);
  }

  // persist seen (rolling 100) and send
  if (newSourceIds.length) saveSeen(seen.concat(newSourceIds));
  if (unmapped.length) {
    console.log(`\n⚠️ ${unmapped.length} unmapped room stay(s):`);
    for (const u of unmapped) console.log(`   [${u.channel}] ${u.roomName}  (src ${u.sourceId})`);
  }

  console.log("\n===== REPORT =====\n" + report + "\n==================\n");
  await sendToZalo(report);
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
