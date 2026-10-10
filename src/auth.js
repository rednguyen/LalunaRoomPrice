// Automated SiteMinder login via Playwright.
//
// Flow (mapped from the live login):
//   1. email  -> "Next"
//   2. password -> submit
//   3. TOTP code (generated from SM_TOTP_SECRET with otplib)
//   4. (optional) "trust this device" / continue prompt
//   5. land on property.siteminder.com
// Saves the authenticated session (cookies + storage) to SM_STATE_FILE.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const { authenticator } = require("otplib");
const { fetchTrustLink } = require("./gmail");

const CFG = {
  user: process.env.SM_USER,
  pass: process.env.SM_PASS,
  totp: process.env.SM_TOTP_SECRET,
  loginUrl: process.env.SM_LOGIN_URL || "https://authx.siteminder.com/login",
  successGlob: process.env.SM_SUCCESS_URL_GLOB || "https://property.siteminder.com/**",
  stateFile: process.env.SM_STATE_FILE || "state/storageState.json",
  headful: String(process.env.SM_HEADFUL).toLowerCase() === "true",
  // "skip" = log in as an untrusted session-only device (default);
  // "confirm" = auto-confirm the trusted-device email via Gmail (IMAP).
  deviceTrust: (process.env.SM_DEVICE_TRUST || "skip").toLowerCase(),
  // Watchability: slow each action down, and keep the window open at the end.
  slowMo: Number(process.env.SM_SLOWMO || 0),
  keepOpenMs: Number(process.env.SM_KEEP_OPEN_MS || 0),
};

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/154.0.0.0 Safari/537.36";

function requireEnv() {
  for (const k of ["user", "pass", "totp"]) {
    if (!CFG[k]) throw new Error(`Missing env: SM_${k.toUpperCase()}. See .env.example.`);
  }
}

// Wait for the first element matching ANY selector (SPA mounts async), then fill.
async function fillAny(page, selectors, value, label, timeout = 25000) {
  const el = page.locator(selectors.join(", ")).first();
  try {
    await el.waitFor({ state: "visible", timeout });
  } catch (_) {
    throw new Error(`Could not find ${label} field`);
  }
  await el.fill(value);
  return true;
}

async function clickAny(page, selectors, label, timeout = 25000) {
  const el = page.locator(selectors.join(", ")).first();
  try {
    await el.waitFor({ state: "visible", timeout });
  } catch (_) {
    throw new Error(`Could not find ${label} button`);
  }
  await el.click();
  return true;
}

async function login() {
  requireEnv();
  fs.mkdirSync(path.dirname(CFG.stateFile), { recursive: true });

  const browser = await chromium.launch({ headless: !CFG.headful, slowMo: CFG.slowMo });
  const ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1920, height: 1080 }, locale: "en-US" });
  const page = await ctx.newPage();

  try {
    await page.goto(CFG.loginUrl, { waitUntil: "domcontentloaded", timeout: 45000 });

    // Step 1: email
    await fillAny(page,
      ['input[type="email"]', 'input[name="username"]', 'input[name="email"]', 'input#email'],
      CFG.user, "email");
    await clickAny(page,
      ['button:has-text("Next")', 'button[type="submit"]', 'button:has-text("Continue")'], "Next");

    // Step 2: password
    await fillAny(page,
      ['input[type="password"]', 'input[name="password"]'], CFG.pass, "password");
    await clickAny(page,
      ['button:has-text("Log in")', 'button:has-text("Login")', 'button:has-text("Sign in")',
       'button:has-text("Next")', 'button[type="submit"]'], "login submit");

    // Step 3: MFA (TOTP) — 6 separate number boxes that auto-submit when filled.
    const code = authenticator.generate(CFG.totp.replace(/\s/g, ""));
    const boxes = page.locator(
      'input.sm-input__field[type="number"], input[autocomplete="one-time-code"], ' +
      'input[name="code"], input[name="otp"]'
    );
    try {
      await boxes.first().waitFor({ state: "visible", timeout: 15000 });
      const n = await boxes.count();
      if (n >= 6) {
        // Segmented input: focus the first box and type digit-by-digit so the
        // component auto-advances focus and auto-submits on the 6th digit.
        await boxes.first().click();
        await page.keyboard.type(code, { delay: 90 });
      } else {
        await boxes.first().fill(code);
        await page.keyboard.press("Enter").catch(() => {});
      }
      // Fallback submit if this variant shows a button instead of auto-submitting.
      await clickAny(page,
        ['button:has-text("Verify")', 'button:has-text("Continue")', 'button:has-text("Submit")'],
        "MFA verify", 3000).catch(() => {});
    } catch (_) {
      // No MFA prompt this run (still a trusted session) — continue.
    }

    // Step 4: "Confirm trusted device" screen (may not appear if already past it).
    if (CFG.deviceTrust === "confirm") {
      const onTrustScreen = await page
        .waitForURL("**/trusted-device-setup", { timeout: 15000 })
        .then(() => true).catch(() => false);
      if (onTrustScreen) {
        const since = new Date(Date.now() - 2 * 60 * 1000);
        console.log("   Trusted-device screen — fetching confirmation email…");
        const link = await fetchTrustLink({ since });
        console.log("   Opening confirmation link in the browser to complete enrollment…");
        // Navigate the login tab to the confirm link: it confirms the device AND
        // lets SiteMinder redirect this session into the app ("follow the links
        // in the email"). A bare GET confirms server-side but doesn't advance the UI.
        await page.goto(link, { waitUntil: "domcontentloaded", timeout: 45000 }).catch(() => {});
        await page.waitForURL(CFG.successGlob, { timeout: 30000 }).catch(async () => {
          // If the confirm page is static, nudge to the app home now that we're trusted.
          await page.goto("https://platform.siteminder.com/", { waitUntil: "domcontentloaded" }).catch(() => {});
        });
      }
    } else {
      // Default "skip": complete login as a session-only (untrusted) device.
      try {
        const skip = page.locator('a:has-text("Skip"), button:has-text("Skip")').first();
        await skip.waitFor({ state: "visible", timeout: 12000 });
        await skip.click();
      } catch (_) {
        // No trusted-device prompt this run — continue.
      }
    }

    // Step 5: wait for the app, then let the final /api/authenticate POST +
    // redirect finish so the real session cookies are set before we save.
    await page.waitForURL(CFG.successGlob, { timeout: 60000 });
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(2500);

    await ctx.storageState({ path: CFG.stateFile });
    console.log(`✅ Logged in. Session saved to ${CFG.stateFile}`);
    console.log(`   Landed on: ${page.url()}`);
    if (CFG.keepOpenMs > 0) {
      console.log(`   Keeping the window open for ${CFG.keepOpenMs / 1000}s…`);
      await page.waitForTimeout(CFG.keepOpenMs);
    }
    return CFG.stateFile;
  } catch (err) {
    const shot = "login_error.png";
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    console.error(`❌ Login failed: ${err.message}`);
    console.error(`   Current URL: ${page.url()}`);
    console.error(`   Screenshot : ${shot}`);
    throw err;
  } finally {
    await browser.close();
  }
}

module.exports = { login, CFG };

if (require.main === module) {
  login().catch(() => process.exit(1));
}
