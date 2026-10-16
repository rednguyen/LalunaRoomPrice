// Passive live monitor for the always-open SiteMinder browser. Connects to its CDP port and
// prints each page it navigates through, in real time. It never opens tabs or navigates, so
// it's safe to run while the Trust or report workflow is driving the browser.
//
// On the VPS, in a second SSH window (as laluna), run during a Trust/report run:
//   cd ~/actions-runner/_work/LalunaRoomPrice/LalunaRoomPrice
//   node deploy/sm-live.js
// Ctrl+C to stop.
const { chromium } = require("/home/laluna/actions-runner/_work/LalunaRoomPrice/LalunaRoomPrice/node_modules/playwright");
const URL_CDP = process.env.SM_CDP_URL || "http://127.0.0.1:9222";
const hide = (u) => u.replace(/([?&](userDeviceToken|code|state|op_token)=)[^&]+/g, "$1…");
const ts = () => new Date().toISOString().slice(11, 19);

(async () => {
  const browser = await chromium.connectOverCDP(URL_CDP);
  const ctx = browser.contexts()[0];
  const seen = new WeakSet();
  const watch = (page) => {
    if (seen.has(page)) return; seen.add(page);
    page.on("framenavigated", (f) => { if (f === page.mainFrame()) console.log(ts(), "PAGE   ", hide(f.url()).slice(0, 150)); });
    page.on("console", (m) => { if (m.type() === "error" && !/contentsquare|Content Security Policy/.test(m.text())) console.log(ts(), "ERROR  ", m.text().slice(0, 140)); });
    page.evaluate(() => location.href).then((u) => console.log(ts(), "TAB    ", hide(u).slice(0, 150))).catch(() => {});
  };
  ctx.on("page", watch);
  ctx.pages().forEach(watch);
  console.log(ts(), "watching", URL_CDP, "— Ctrl+C to stop");
  setInterval(() => ctx.pages().forEach(watch), 2000);
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
