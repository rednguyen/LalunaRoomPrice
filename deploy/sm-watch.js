// Diagnostic: open SiteMinder in the bot's own profile and record what the login flow does
// (page changes, SiteMinder API responses, page errors) for 60s, then save a screenshot.
// Never types credentials — it only reuses whatever session the profile already has.
//
// On the VPS, as laluna, from the runner's checkout (it has node_modules):
//   cd ~/actions-runner/_work/LalunaRoomPrice/LalunaRoomPrice
//   SM_PROFILE_DIR=/home/laluna/sm-profile SM_SUCCESS_URL_GLOB='https://platform.siteminder.com/**' \
//     node /home/laluna/sm-watch.js
// Close the desktop "SiteMinder (bot profile)" browser first (one profile can't be open twice).
const req = require("module").createRequire(process.cwd() + "/");
const { openBrowser, CFG } = req("./src/auth");

const hide = (u) => u.replace(/([?&](userDeviceToken|code|state|op_token)=)[^&]+/g, "$1…");

(async () => {
  const { ctx, close } = await openBrowser();
  const page = await ctx.newPage();
  const t0 = Date.now();
  const ts = () => ((Date.now() - t0) / 1000).toFixed(1).padStart(5) + "s";
  page.on("framenavigated", (f) => { if (f === page.mainFrame()) console.log(ts(), "PAGE   ", hide(f.url()).slice(0, 150)); });
  page.on("pageerror", (e) => console.log(ts(), "JSERROR", e.message.slice(0, 160)));
  page.on("console", (m) => { if (m.type() === "error" && !/contentsquare|Content Security Policy/.test(m.text())) console.log(ts(), "CONSOLE", m.text().slice(0, 160)); });
  page.on("requestfailed", (r) => { if (/siteminder/.test(r.url())) console.log(ts(), "FAILED ", r.failure()?.errorText, hide(r.url()).slice(0, 120)); });
  page.on("response", async (r) => {
    if (!/siteminder\.com/.test(r.url()) || r.request().method() === "GET") return;
    const op = (r.request().postData() || "").match(/"operationName":"(\w+)"/)?.[1] || "";
    let body = "";
    if (r.status() >= 400) body = (await r.text().catch(() => "")).slice(0, 120);
    console.log(ts(), "API    ", r.status(), hide(r.url()).replace(/\?.*/, "").slice(0, 100), op, body);
  });

  await page.goto(CFG.loginUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(60000);
  console.log(ts(), "FINAL  ", hide(page.url()).slice(0, 150));
  console.log("PAGE TEXT:", JSON.stringify((await page.innerText("body").catch(() => "")).slice(0, 300)));
  await page.screenshot({ path: "/tmp/sm-watch.png" });
  console.log("Screenshot: /tmp/sm-watch.png");
  await close();
})().catch((e) => { console.error("❌", e.message); process.exit(1); });
