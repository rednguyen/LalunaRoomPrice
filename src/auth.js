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

const CFG = {
  user: process.env.SM_USER,
  pass: process.env.SM_PASS,
  totp: process.env.SM_TOTP_SECRET,
  loginUrl: process.env.SM_LOGIN_URL || "https://authx.siteminder.com/login",
  successGlob: process.env.SM_SUCCESS_URL_GLOB || "https://property.siteminder.com/**",
  stateFile: process.env.SM_STATE_FILE || "state/storageState.json",
  // Optional persistent browser profile (see openBrowser). Keep it outside the repo.
  profileDir: process.env.SM_PROFILE_DIR,
  // Optional: attach to an always-open, already-trusted browser instead of launching one
  // (SM_CDP_URL, e.g. http://127.0.0.1:9222). The one browser stays the trusted device.
  cdpUrl: process.env.SM_CDP_URL,
  headful: String(process.env.SM_HEADFUL).toLowerCase() === "true",
  // "skip" = log in as an untrusted session-only device (default);
  // "manual" = wait on the trusted-device screen for a human to click the email link.
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

// Steps 1–4 of the login form: email, password, TOTP, trusted-device screen.
async function signIn(page) {
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
  if (CFG.deviceTrust === "manual") {
    // A human trusts this device: they click the link in SiteMinder's "trusted device"
    // email, and this login page then moves on into the app by itself.
    const onTrustScreen = await page
      .waitForURL("**/trusted-device-setup", { timeout: 15000 })
      .then(() => true).catch(() => false);
    if (onTrustScreen) {
      const waitMs = Number(process.env.SM_TRUST_WAIT_MS || 300000);
      // "Trust this device for faster logins": the confirmation email is only sent once
      // "Make trusted device" is clicked (some logins send it straight away, no button).
      const makeTrusted = page.locator('button:has-text("Make trusted device"), a:has-text("Make trusted device")').first();
      if (await makeTrusted.isVisible({ timeout: 5000 }).catch(() => false)) {
        await makeTrusted.click();
        console.log('   Clicked "Make trusted device" — SiteMinder is emailing the confirmation link.');
      }
      console.log(`   Click the link in SiteMinder's email (waiting up to ${waitMs / 60000} min)…`);
      // Done when the login reaches the app (an intermediate "check your email" page doesn't count).
      await page.waitForURL(CFG.successGlob, { timeout: waitMs }).catch(() => {
        throw new Error(`Device not confirmed within ${waitMs / 60000} min`);
      });
      console.log("   Device confirmed.");
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
}

async function login() {
  requireEnv();
  fs.mkdirSync(path.dirname(CFG.stateFile), { recursive: true });

  const { ctx, close } = await openBrowser();
  // Trusting the device: start from a fresh sign-in, or a session still logged in from an
  // untrusted ("Skip") run would never reach the "trusted device" screen. Only cookies go —
  // the device key in IndexedDB stays, so an already-trusted device just isn't asked again.
  // In attach mode this clears the always-open browser's cookies so it re-enrolls cleanly.
  if (CFG.deviceTrust === "manual") await ctx.clearCookies();
  const page = await ctx.newPage();

  try {
    await page.goto(CFG.loginUrl,{ waitUntil: "domcontentloaded", timeout: 45000 });

    // A persistent profile (SM_PROFILE_DIR) may still be logged in: the login URL then
    // bounces straight into the app and the form steps are skipped.
    const already = CFG.profileDir &&
      (await page.waitForURL(CFG.successGlob, { timeout: 10000 }).then(() => true, () => false));
    if (already) console.log("   Profile is still logged in.");
    else await signIn(page);

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
    await close();
  }
}

// SM_PROFILE_DIR set: one browser profile kept on disk, so cookies AND the browser's
// IndexedDB survive between runs — the trusted-device signing key lives there (needed to
// reveal guest emails). Unset: a throwaway browser per run, session carried in SM_STATE_FILE.
async function openBrowser({ storageState } = {}) {
  const opts = { userAgent: UA, viewport: { width: 1920, height: 1080 }, locale: "en-US" };
  // Attach to the always-open, human-trusted browser (SM_CDP_URL) instead of launching one.
  // No fresh browser and no fresh login per run, so SiteMinder keeps seeing the single device
  // it trusted (a fresh launch/login is what made it drop the trust). The keepalive service
  // (deploy/sm-keepalive.sh) starts that browser with this same user agent.
  if (CFG.cdpUrl) {
    const browser = await chromium.connectOverCDP(CFG.cdpUrl, { slowMo: CFG.slowMo });
    const ctx = browser.contexts()[0];
    const before = new Set(ctx.pages());
    return {
      ctx, attached: true,
      close: async () => {
        for (const p of ctx.pages()) if (!before.has(p)) await p.close().catch(() => {});
        await browser.close();   // over CDP this only detaches — the browser keeps running
      },
    };
  }
  if (CFG.profileDir) {
    const ctx = await chromium.launchPersistentContext(CFG.profileDir, { headless: !CFG.headful, slowMo: CFG.slowMo, ...opts });
    // Auth0 leaves a "login in progress" cookie pair (com.auth0.auth.<state> + _compat, and
    // co/verifier) for every login that starts but doesn't finish. In a long-lived profile they
    // pile up until authx rejects the request (HTTP 431 "headers too large" → /error page, and the
    // device stops being recognised). They're useless once that login is gone — drop them.
    // AUTH_X_DEVICE_ID (trusted device) and AUTH_X_TOKEN (session) are untouched.
    await ctx.clearCookies({ domain: "authx.siteminder.com", name: /^_?(com\.auth0\.auth\.|co%2Fverifier)/ });
    return { ctx, close: () => ctx.close() };
  }
  const browser = await chromium.launch({ headless: !CFG.headful, slowMo: CFG.slowMo });
  const ctx = await browser.newContext({ ...opts, ...(storageState ? { storageState } : {}) });
  return { ctx, close: () => browser.close() };
}

module.exports = { login, openBrowser, CFG };

if (require.main === module) {
  login().catch(() => process.exit(1));
}
