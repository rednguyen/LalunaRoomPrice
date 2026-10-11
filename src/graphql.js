// Reusable authenticated GraphQL client for SiteMinder's cm-beef endpoint.
//
// Auth recipe (proven): load the saved session, navigate once to the dashboard so
// the app sets sm_access_token + sm_xsrf_token on platform.siteminder.com, then
// POST with the sm_xsrf_token value as the `x-xsrf-token` header. Cookies ride
// along automatically. Reuses the saved session and only re-logs in on a 401.
require("dotenv").config();
const fs = require("fs");
const { chromium } = require("playwright");
const { login, CFG } = require("./auth");

const SPID = process.env.SM_SPID;
const GQL_URL = process.env.SM_GRAPHQL_URL || "https://platform.siteminder.com/api/cm-beef/graphql";
const DASHBOARD = (spid) => `https://platform.siteminder.com/dashboard/${spid}`;

class AuthError extends Error {}

// Open an authenticated context and hand `fn` a runner it can call many times.
async function withGraphql(fn) {
  const browser = await chromium.launch({ headless: !CFG.headful });
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, storageState: CFG.stateFile });
  const page = await ctx.newPage();
  try {
    await page.goto(DASHBOARD(SPID), { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForLoadState("networkidle", { timeout: 30000 }).catch(() => {});
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

      if (res.status === 401 || res.status === 403) throw new AuthError(`GraphQL ${res.status}: ${res.text.slice(0, 160)}`);
      let json;
      try { json = JSON.parse(res.text); } catch { throw new Error(`Non-JSON response: ${res.text.slice(0, 200)}`); }
      if (json.errors) throw new Error(`GraphQL errors: ${JSON.stringify(json.errors).slice(0, 300)}`);
      return json.data;
    };

    return await fn(run);
  } finally {
    await browser.close();
  }
}

// Reuse the saved session; log in if it's missing or expired, then retry once.
async function withGraphqlAuth(fn) {
  if (!fs.existsSync(CFG.stateFile)) {
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
