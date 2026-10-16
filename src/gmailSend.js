// Send email through Gmail's SMTP server with a Google App Password.
//
//   node src/gmailSend.js --test you@x.com   sends the cancellation email to YOUR address
//
// Config (.env): GMAIL_USER (the sending Gmail address), GMAIL_APP_PASSWORD (16-char App
// Password from myaccount.google.com/apppasswords — needs 2-Step Verification on),
// GMAIL_FROM (e.g. "Laluna Hoi An Riverside Hotel & Spa <you@gmail.com>").
// The address must be the one Booking.com accepts for the guest relay (proven by hand).
require("dotenv").config();
const fs = require("fs");
const nodemailer = require("nodemailer");

const CFG = {
  user: process.env.GMAIL_USER,
  pass: (process.env.GMAIL_APP_PASSWORD || "").replace(/\s/g, ""),   // Google shows it in 4 groups
  from: process.env.GMAIL_FROM || process.env.GMAIL_USER,
  templateFile: process.env.GUEST_EMAIL_TEMPLATE || "cancellationEmail.txt",
};
const configured = () => !!(CFG.user && CFG.pass);

// ---- template: first line "Subject: …", a blank line, then the body ({guestName}) ----
function renderTemplate(vars) {
  const raw = fs.readFileSync(CFG.templateFile, "utf8").replace(/\r\n/g, "\n");
  const [head, ...rest] = raw.split("\n\n");
  const m = /^Subject:\s*(.+)$/m.exec(head);
  if (!m) throw new Error(`${CFG.templateFile}: first line must be "Subject: …"`);
  const fill = (s) => s.replace(/\{(\w+)\}/g, (all, k) => (vars[k] != null ? String(vars[k]) : all));
  return { subject: fill(m[1].trim()), text: fill(rest.join("\n\n").trim()) + "\n" };
}

let transport;
// Resolves once Gmail has ACCEPTED the message (returns its id); throws otherwise.
async function sendEmail({ to, subject, text }) {
  if (!configured()) throw new Error("Gmail not configured (GMAIL_USER / GMAIL_APP_PASSWORD)");
  transport = transport || nodemailer.createTransport({
    host: "smtp.gmail.com", port: 465, secure: true, auth: { user: CFG.user, pass: CFG.pass },
  });
  try {
    const info = await transport.sendMail({ from: CFG.from, to, subject, text });
    if (info.rejected && info.rejected.length) throw new Error(`rejected: ${info.rejected.join(", ")}`);
    return info.messageId;
  } catch (e) {
    throw new Error(`Gmail send failed: ${e.message}`);
  }
}

async function test(to) {
  if (!to) throw new Error("Usage: node src/gmailSend.js --test you@example.com");
  const msg = renderTemplate({ guestName: "Test Guest" });
  const id = await sendEmail({ to, ...msg });
  console.log(`✅ Sent "${msg.subject}" to ${to} (${id}).`);
  transport.close();
}

module.exports = { sendEmail, renderTemplate, configured };

if (require.main === module) {
  const i = process.argv.indexOf("--test");
  (i >= 0 ? test(process.argv[i + 1]) : Promise.resolve(console.log("Usage: node src/gmailSend.js --test you@example.com")))
    .catch((e) => { console.error("❌", e.message); process.exit(1); });
}
