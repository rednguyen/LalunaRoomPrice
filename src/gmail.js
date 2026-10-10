// Read Gmail over IMAP to find SiteMinder's "confirm trusted device" email and
// return its one-click confirmation link. Uses an app password (account must
// have 2FA enabled; generate at https://myaccount.google.com/apppasswords).
const { ImapFlow } = require("imapflow");
const { simpleParser } = require("mailparser");

const GCFG = {
  host: process.env.GMAIL_HOST || "imap.gmail.com",
  port: Number(process.env.GMAIL_PORT || 993),
  user: process.env.GMAIL_USER,
  pass: process.env.GMAIL_APP_PASSWORD,
  // Accept mail whose From contains ANY of these (comma-separated). Broadened to
  // cover forwarding (e.g. "...via phutholaluna"). The link pattern below is the
  // decisive gate, so this stays lenient.
  fromHints: (process.env.GMAIL_FROM_HINT || "siteminder,phutholaluna")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  // Subject must contain one of these (covers "[Security] Confirm your new
  // trusted device" and its "Fwd:" forwarded form).
  subjectHints: (process.env.GMAIL_SUBJECT_HINT || "trusted device")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  linkRe: new RegExp(
    process.env.GMAIL_LINK_RE || "https?:\\/\\/[^\"'\\s>]*siteminder\\.com[^\"'\\s>]*" +
      "(?:trust|confirm|device|verify)[^\"'\\s>]*",
    "i"
  ),
};

function requireGmailEnv() {
  if (!GCFG.user || !GCFG.pass) {
    throw new Error("Missing GMAIL_USER / GMAIL_APP_PASSWORD. See .env.example.");
  }
}

// Pull the confirmation link out of one parsed message, if present.
function extractLink(parsed) {
  const bodies = [parsed.html || "", parsed.text || "", parsed.textAsHtml || ""];
  for (const b of bodies) {
    const m = b.match(GCFG.linkRe);
    if (m) return m[0].replace(/&amp;/g, "&");
  }
  return null;
}

// Poll the inbox until a matching email arrives (or timeout). `since` limits to
// recent mail so we don't grab a stale confirmation from a previous run.
async function fetchTrustLink({ since, timeoutMs = 90000, pollMs = 5000 } = {}) {
  requireGmailEnv();
  const sinceDate = since || new Date(Date.now() - 2 * 60 * 1000);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const client = new ImapFlow({
      host: GCFG.host, port: GCFG.port, secure: true,
      auth: { user: GCFG.user, pass: GCFG.pass }, logger: false,
    });
    await client.connect();
    try {
      const lock = await client.getMailboxLock("INBOX");
      try {
        // newest first: search recent messages, scan for the link
        const uids = await client.search({ since: sinceDate }, { uid: true });
        for (const uid of uids.reverse()) {
          const msg = await client.fetchOne(uid, { source: true }, { uid: true });
          if (!msg || !msg.source) continue;
          const parsed = await simpleParser(msg.source);
          const from = ((parsed.from && parsed.from.text) || "").toLowerCase();
          const subject = (parsed.subject || "").toLowerCase();
          const senderOk = GCFG.fromHints.some((h) => from.includes(h));
          const subjectOk = GCFG.subjectHints.some((h) => subject.includes(h));
          if (!senderOk || !subjectOk) continue;
          const link = extractLink(parsed); // decisive gate: a real SiteMinder trust link
          if (link) return link;
        }
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => {});
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`No SiteMinder trusted-device email found within ${timeoutMs}ms`);
}

module.exports = { fetchTrustLink, GCFG };
