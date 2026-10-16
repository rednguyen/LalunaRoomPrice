// Screenshot the current page of the always-open browser (read-only, no navigation).
// On the VPS (as laluna, in the runner checkout):  node deploy/sm-shot.js
// Then from your PC:  scp root@<vps>:/tmp/stuck.png .
const { chromium } = require("/home/laluna/actions-runner/_work/LalunaRoomPrice/LalunaRoomPrice/node_modules/playwright");
(async () => {
  const b = await chromium.connectOverCDP(process.env.SM_CDP_URL || "http://127.0.0.1:9222");
  const p = b.contexts()[0].pages()[0];
  await p.screenshot({ path: "/tmp/stuck.png" });
  console.log("url:", p.url().replace(/(code|state|userDeviceToken)=[^&]+/g, "$1=…"));
  const txt = await p.evaluate(() => document.body.innerText.slice(0, 200)).catch(() => "");
  console.log("text:", JSON.stringify(txt));
  await b.close();
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
