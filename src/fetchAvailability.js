// Pull room-type availability for the next 30 days and print it as a table.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { withGraphqlAuth, SPID } = require("./graphql");

// Room types come from roomTypes.json ([{uuid, name}, ...]). Names are used as
// CSV headers / legend labels; blank names fall back to the UUID.
const ROOM_TYPES_FILE = process.env.SM_ROOM_TYPES_FILE || "roomTypes.json";
const ROOM_TYPES = JSON.parse(fs.readFileSync(ROOM_TYPES_FILE, "utf8"));
const ROOM_TYPE_UUIDS = ROOM_TYPES.map((r) => r.uuid);
const NAME_BY_UUID = new Map(ROOM_TYPES.map((r) => [r.uuid, (r.name || "").trim() || r.uuid]));

const DAYS = Number(process.env.SM_DAYS || 365);

const QUERY = `query roomTypeDates($spid: ID!, $roomTypeUuids: [ID!]!, $dates: [LocalDate!]!, $isCmInventoryGridFeatureEnabled: Boolean!) {
  roomTypeDates(spid: $spid, roomTypeUuids: $roomTypeUuids, dates: $dates) @include(if: $isCmInventoryGridFeatureEnabled) {
    id
    roomTypeUuid
    available
    date
    __typename
  }
}`;

function nextDates(n) {
  const out = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate() + i);
    out.push(`${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`);
  }
  return out;
}

function printTable(rows, dates) {
  // lookup: date|uuid -> available
  const map = new Map();
  for (const r of rows) map.set(`${r.date}|${r.roomTypeUuid}`, r.available);

  // column labels A, B, C … for each room type
  const labels = ROOM_TYPE_UUIDS.map((_, i) => String.fromCharCode(65 + i));
  console.log("\nRoom types:");
  ROOM_TYPE_UUIDS.forEach((u, i) => console.log(`  ${labels[i]} = ${NAME_BY_UUID.get(u)}  (${u})`));

  const w = 3; // column width for numbers
  const header = "Date".padEnd(12) + labels.map((l) => l.padStart(w)).join(" ");
  console.log("\n" + header);
  console.log("-".repeat(header.length));
  for (const date of dates) {
    const cells = ROOM_TYPE_UUIDS.map((u) => {
      const v = map.get(`${date}|${u}`);
      return (v === undefined ? "-" : String(v)).padStart(w);
    });
    console.log(date.padEnd(12) + cells.join(" "));
  }
}

(async () => {
  if (!SPID) throw new Error("SM_SPID is not set in .env");
  const dates = nextDates(DAYS);
  console.log(`Fetching availability for ${ROOM_TYPE_UUIDS.length} room types × ${dates.length} days`);
  console.log(`spid ${SPID}  |  ${dates[0]} … ${dates[dates.length - 1]}`);

  // Chunk the date range so large windows (e.g. a full year) don't hit
  // server-side limits. One login/session is reused across all chunks.
  const CHUNK = Number(process.env.SM_CHUNK_DAYS || 30);
  const chunks = [];
  for (let i = 0; i < dates.length; i += CHUNK) chunks.push(dates.slice(i, i + CHUNK));

  const rows = await withGraphqlAuth(async (run) => {
    const all = [];
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      const data = await run("roomTypeDates", QUERY, {
        spid: SPID, roomTypeUuids: ROOM_TYPE_UUIDS, dates: chunk, isCmInventoryGridFeatureEnabled: true,
      });
      const got = (data && data.roomTypeDates) || [];
      all.push(...got);
      console.log(`  chunk ${i + 1}/${chunks.length} (${chunk[0]} … ${chunk[chunk.length - 1]}): ${got.length} rows`);
      if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 300)); // be polite
    }
    return all;
  });

  console.log(`\n✅ ${rows.length} rows returned across ${chunks.length} request(s).`);
  if (dates.length <= 45) {
    printTable(rows, dates);
  } else {
    console.log(`(Table skipped for ${dates.length} days — see the saved files.)`);
  }
  writeOutputs(rows, dates);
})().catch((e) => { console.error("❌", e.message); process.exit(1); });

function writeOutputs(rows, dates) {
  // Single CSV at a fixed path, overwritten every run.
  const csvPath = process.env.SM_OUT_FILE || "data/availability.csv";
  fs.mkdirSync(path.dirname(csvPath), { recursive: true });

  // Wide grid: date + one column per room type. Easy to open in Excel.
  const map = new Map(rows.map((r) => [`${r.date}|${r.roomTypeUuid}`, r.available]));
  const q = (s) => (/[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s);
  const header = ["date", ...ROOM_TYPE_UUIDS.map((u) => q(NAME_BY_UUID.get(u)))].join(",");
  const lines = dates.map((d) =>
    [d, ...ROOM_TYPE_UUIDS.map((u) => { const v = map.get(`${d}|${u}`); return v === undefined ? "" : v; })].join(",")
  );
  fs.writeFileSync(csvPath, [header, ...lines].join("\n") + "\n");

  console.log(`\n💾 Saved (overwritten): ${path.resolve(csvPath)}`);
}
