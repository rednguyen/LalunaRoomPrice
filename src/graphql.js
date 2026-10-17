// Reusable authenticated GraphQL client for SiteMinder's cm-beef endpoint.
//
// Auth recipe (proven): load the saved session, navigate once to the dashboard so
// the app sets sm_access_token + sm_xsrf_token on platform.siteminder.com, then
// POST with the sm_xsrf_token value as the `x-xsrf-token` header. Cookies ride
// along automatically. Reuses the saved session and only re-logs in on a 401.
require("dotenv").config();
const fs = require("fs");
const { login, openBrowser, CFG } = require("./auth");

const SPID = process.env.SM_SPID;
const GQL_URL = process.env.SM_GRAPHQL_URL || "https://platform.siteminder.com/api/cm-beef/graphql";
const DASHBOARD = (spid) => `https://platform.siteminder.com/dashboard/${spid}`;

class AuthError extends Error {}

// Open an authenticated context and hand `fn` a runner it can call many times.
async function withGraphql(fn) {
  const { ctx, close } = await openBrowser({ storageState: CFG.stateFile });
  const page = await ctx.newPage();
  try {
    if (CFG.profileDir) {
      // Persistent (VPS) profile: start where a person would — SiteMinder's login address.
      // A logged-in, trusted profile then walks SiteMinder's hand-off by itself (authx
      // /authenticated → /authenticate?userDeviceToken=… → a brief …/forbidden → re-authorise)
      // and lands on the dashboard (~10 s on the VPS). Opening the dashboard URL directly skips
      // that hand-off. If the login form shows instead, the session is gone → log in.
      await page.goto(CFG.loginUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      const onDashboard = (u) => u.hostname === "platform.siteminder.com" && u.pathname.startsWith("/dashboard/");
      const landed = await page.waitForURL(onDashboard, { timeout: 90000 }).then(() => true, () => false);
      if (!landed) throw new AuthError(`didn't reach the dashboard from the login page (stopped on ${new URL(page.url()).pathname})`);
      await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    } else {
      await page.goto(DASHBOARD(SPID), { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
    }
    await page.waitForTimeout(1000);

    if (/\/login/.test(page.url())) throw new AuthError("redirected to login");
    const xsrf = (await ctx.cookies("https://platform.siteminder.com")).find((c) => c.name === "sm_xsrf_token");
    if (!xsrf) throw new AuthError("no sm_xsrf_token cookie (session likely invalid)");

    const run = async (operationName, query, variables, url = GQL_URL) => {
      const res = await page.evaluate(async ({ url, token, body }) => {
        const r = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json", "x-xsrf-token": token },
          credentials: "include",
          body: JSON.stringify(body),
        });
        return { status: r.status, text: await r.text() };
      }, { url, token: xsrf.value, body: { operationName, query, variables } });

      if (res.status === 401 || res.status === 403) {
        // Risk-engine step-up (common from datacenter IPs) can't be cleared by an
        // in-process re-login — fail so the outer retry starts a fresh attempt.
        if (/step_up_required/i.test(res.text)) {
          throw new Error(`GraphQL ${res.status} step_up_required — risk engine wants step-up auth; failing for a fresh retry.`);
        }
        throw new AuthError(`GraphQL ${res.status}: ${res.text.slice(0, 160)}`);
      }
      let json;
      try { json = JSON.parse(res.text); } catch { throw new Error(`Non-JSON response: ${res.text.slice(0, 200)}`); }
      if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors).slice(0, 300)}`);
      return json.data;
    };

    return await fn(run, page);   // page: for steps that must run in the browser (trusted-device signing)
  } finally {
    await close();
  }
}

// Reuse the saved session; log in if it's missing or expired, then retry once.
async function withGraphqlAuth(fn) {
  // Profile mode (VPS): the session lives in the browser profile, so REUSE it — withGraphql
  // navigates the login URL and waits patiently for the dashboard. We do NOT log in just
  // because the state file is missing: a fresh login (skip mode) clicks "Skip", which replaces
  // the trusted session with an untrusted one and breaks the guest-email reveal. Only log in on
  // a genuine AuthError (the session is really gone — rare).
  if (!CFG.profileDir && !fs.existsSync(CFG.stateFile)) {
    console.log("No saved session — logging in…");
    await login();
  }
  try {
    return await withGraphql(fn);
  } catch (e) {
    if (e instanceof AuthError) {
      console.log(`Session invalid (${e.message}) — re-logging in…`);
      await login();
      return await withGraphql(fn);
    }
    throw e;
  }
}

module.exports = { withGraphqlAuth, AuthError, SPID };
