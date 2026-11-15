// Travel Agent (TA) bookings for the "Báo Cáo TA Sales" report.
//
//   GET <TA_API_URL>   header x-api-key: <TA_API_KEY>
//   -> { rows: [{ id, agent, checkIn, checkOut, currency, totalAmount, guest, rooms }] }
// Returns the most recent 10 TA bookings. `rooms` is a comma-separated string of room
// codes, one per room ("SUPDB, SUPDB" = 2 rooms), mapped to SiteMinder rooms through the
// "TA" key in roomMappings.json (one code or a list of codes).
//
// Dedupe: its own log (TA_SEEN_FILE, rolling last 100 ids). The API always returns the
// latest 10, so an id must stay remembered until 10 newer TA bookings push it out.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const axios = require("axios");

const URL = process.env.TA_API_URL || "https://50.6.199.216.sslip.io/api/ta-sales";
const KEY = process.env.TA_API_KEY;
const SEEN_FILE = process.env.TA_SEEN_FILE || "state/seenTaBookings.json";
const SEEN_CAP = 100;

const roomMappings = JSON.parse(fs.readFileSync("roomMappings.json", "utf8")); // {smName:{..., TA}}
const normCode = (c) => String(c || "").trim().toUpperCase();
// TA room code -> SiteMinder room name (exact match, case/space-insensitive).
const SM_BY_CODE = new Map();
for (const [smName, ch] of Object.entries(roomMappings)) {
  for (const code of [].concat(ch.TA || [])) if (normCode(code)) SM_BY_CODE.set(normCode(code), smName);
}

const configured = () => !!KEY;

// Normalised bookings: { id, agent, guest, checkIn, checkOut, currency, totalAmount, rooms: [code] }
async function fetchTaBookings() {
  if (!configured()) throw new Error("TA_API_KEY is not set");
  const res = await axios.get(URL, { headers: { "x-api-key": KEY }, timeout: 30000 });
  const rows = res.data && res.data.rows;
  if (!Array.isArray(rows)) throw new Error(`unexpected TA API response: ${JSON.stringify(res.data).slice(0, 200)}`);
  return rows.map((r) => ({
    id: String(r.id),
    agent: String(r.agent || "").trim(),
    guest: String(r.guest || "").trim(),
    checkIn: r.checkIn,
    checkOut: r.checkOut,
    currency: r.currency || "VND",
    totalAmount: r.totalAmount,
    rooms: String(r.rooms || "").split(",").map(normCode).filter(Boolean),
  }));
}

const roomTypeForCode = (code) => SM_BY_CODE.get(normCode(code)) || null;

function loadSeenTa() {
  try { return JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")).ids || []; } catch { return []; }
}
function saveSeenTa(ids) {
  fs.mkdirSync(path.dirname(SEEN_FILE), { recursive: true });
  fs.writeFileSync(SEEN_FILE, JSON.stringify({ ids: ids.slice(-SEEN_CAP) }, null, 2) + "\n");
}

module.exports = { fetchTaBookings, roomTypeForCode, loadSeenTa, saveSeenTa, configured };
