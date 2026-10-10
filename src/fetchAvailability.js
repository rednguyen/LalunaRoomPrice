// Pull room-type availability for the next 30 days and print it as a table.
require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { withGraphqlAuth, SPID } = require("./graphql");

const DEFAULT_ROOM_TYPES = [
  "hb1t7om5re23c0gx", "bqldea8rpetossgw", "lxdvyjthjsczwfso", "lal50vd680svurcy",
  "ectsohufybm6oyzm", "wanj8h8tuqlyutgo", "49mlpyvbr4rf0h4k", "pgtxjvurkqzinjg9",
  "hwn87gwt3zlttgls", "6qodw8wd3zqrukkb",
];
const ROOM_TYPE_UUIDS = (process.env.SM_ROOM_TYPE_UUIDS
  ? process.env.SM_ROOM_TYPE_UUIDS.split(",").map((s) => s.trim()).filter(Boolean)
  : DEFAULT_ROOM_TYPES);

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
  ROOM_TYPE_UUIDS.forEach((u, i) => console.log(`  ${labels[i]} = ${u}`));

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
  const header = ["date", ...ROOM_TYPE_UUIDS].join(",");
  const lines = dates.map((d) =>
    [d, ...ROOM_TYPE_UUIDS.map((u) => { const v = map.get(`${d}|${u}`); return v === undefined ? "" : v; })].join(",")
  );
  fs.writeFileSync(csvPath, [header, ...lines].join("\n") + "\n");

  console.log(`\n💾 Saved (overwritten): ${path.resolve(csvPath)}`);
}
