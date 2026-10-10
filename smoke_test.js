// Feasibility smoke test: can headless Playwright load the SiteMinder login
// page, or does Cloudflare throw a bot challenge? No credentials used.
const { chromium } = require("playwright");

const LOGIN_URL = "https://authx.siteminder.com/login";

(async () => {
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
      "(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
  });
  const page = await ctx.newPage();

  let status = null;
  page.on("response", (r) => {
    if (r.url() === LOGIN_URL || r.url().startsWith(LOGIN_URL)) status = r.status();
  });

  const resp = await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page.waitForTimeout(5000); // let JS / any challenge settle

  const title = await page.title();
  const url = page.url();

  // Cloudflare challenge indicators
  const cf = await page.evaluate(() => {
    const html = document.documentElement.innerHTML;
    return {
      turnstile: !!document.querySelector('iframe[src*="challenges.cloudflare.com"]'),
      challengeRunning: !!document.querySelector("#challenge-running, #cf-challenge-running"),
      justAMoment: /just a moment|checking your browser|verify you are human/i.test(
        document.title + " " + html.slice(0, 2000)
      ),
    };
  });

  // Did the real login form render?
  const form = await page.evaluate(() => ({
    emailInput: !!document.querySelector(
      'input[type="email"], input[name="username"], input[name="email"]'
    ),
    passwordInput: !!document.querySelector('input[type="password"]'),
    anyInput: document.querySelectorAll("input").length,
  }));

  await page.screenshot({ path: "smoke_result.png", fullPage: true });

  console.log("=== SMOKE TEST RESULT ===");
  console.log("navigation status :", resp ? resp.status() : status);
  console.log("final URL         :", url);
  console.log("page title        :", JSON.stringify(title));
  console.log("cloudflare flags  :", JSON.stringify(cf));
  console.log("login form        :", JSON.stringify(form));
  console.log("screenshot        : smoke_result.png");

  const challenged = cf.turnstile || cf.challengeRunning || cf.justAMoment;
  const formOk = form.emailInput || form.passwordInput;
  console.log("\nVERDICT           :",
    challenged ? "❌ Cloudflare challenge detected"
    : formOk   ? "✅ Login form rendered — Playwright gets through"
    :            "⚠️ No challenge, but no login form found — inspect screenshot");

  await browser.close();
})().catch((e) => {
  console.error("SMOKE TEST ERROR:", e.message);
  process.exit(1);
});
