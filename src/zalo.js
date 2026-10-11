// Zalo Bot API sender.
//   POST https://bot-api.zaloplatforms.com/bot<TOKEN>/sendMessage  { chat_id, text }
//
// Configure ZALO_BOT_TOKEN + ZALO_CHAT_ID in .env. If they're missing (or a send
// fails), the report is printed to the console so the pipeline stays testable.
// Long reports are split into multiple messages on line boundaries.
require("dotenv").config();
const axios = require("axios");

const TOKEN = process.env.ZALO_BOT_TOKEN;
const CHAT_ID = process.env.ZALO_CHAT_ID;
const API_BASE = process.env.ZALO_API_BASE || "https://bot-api.zaloplatforms.com";
const MAX_LEN = Number(process.env.ZALO_MAX_LEN || 2000);

// Fallback: split a single oversized block into <=max chunks on line boundaries.
function chunkByLines(text, max) {
  const chunks = [];
  let cur = "";
  for (const line of text.split("\n")) {
    if (line.length > max) {
      if (cur) { chunks.push(cur); cur = ""; }
      for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max));
      continue;
    }
    if (cur && cur.length + 1 + line.length > max) { chunks.push(cur); cur = ""; }
    cur = cur ? cur + "\n" + line : line;
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// Pack whole room-type sections into <=max messages so a section is never split
// across two messages (unless it alone exceeds max). The title (text before the
// first blank line) goes on the FIRST message only. Sections are delimited by a
// dashed separator line.
const SEP = "----------------------------------------";
function chunkReport(text, max) {
  const idx = text.indexOf("\n\n");
  const header = idx >= 0 ? text.slice(0, idx) : "";
  const body = idx >= 0 ? text.slice(idx + 2) : text;
  const prefixLen = header ? header.length + 2 : 0;
  const joiner = `\n${SEP}\n`;
  const sections = body ? body.split(/\n-{3,}\n/) : [];
  if (sections.length === 0) return header ? [header] : [];

  // Only the first message carries the header, so it gets less room; the rest
  // get the full max.
  const bodies = [];
  let cur = "";
  const budget = () => Math.max(1, max - (bodies.length === 0 ? prefixLen : 0));
  const flush = () => { if (cur) { bodies.push(cur); cur = ""; } };
  for (const sec of sections) {
    if (sec.length > budget()) { flush(); for (const p of chunkByLines(sec, budget())) bodies.push(p); continue; }
    if (cur && cur.length + joiner.length + sec.length > budget()) flush();
    cur = cur ? cur + joiner + sec : sec;
  }
  flush();
  return bodies.map((b, i) => (i === 0 && header ? header + "\n\n" + b : b));
}

const configured = (v) => v && !/paste|your-|12345689:abc-xyz/i.test(v);

async function sendToZalo(message) {
  if (!configured(TOKEN) || !configured(CHAT_ID)) {
    console.log("\n[zalo] ZALO_BOT_TOKEN / ZALO_CHAT_ID not set — printing report instead:\n");
    console.log(message);
    return { sent: false, reason: "not-configured" };
  }

  const url = `${API_BASE}/bot${TOKEN}/sendMessage`;
  const chunks = chunkReport(message, MAX_LEN);
  for (let i = 0; i < chunks.length; i++) {
    try {
      const res = await axios.post(url, { chat_id: CHAT_ID, text: chunks[i] });
      console.log(`[zalo] sent ${i + 1}/${chunks.length}: HTTP ${res.status}`);
    } catch (e) {
      const status = e.response && e.response.status;
      const data = e.response && e.response.data;
      console.error(`[zalo] send failed (chunk ${i + 1}/${chunks.length}): ${status || e.message}` +
        (data ? ` ${JSON.stringify(data).slice(0, 300)}` : ""));
      return { sent: false, reason: e.message, status };
    }
    if (i < chunks.length - 1) await new Promise((r) => setTimeout(r, 400));
  }
  return { sent: true, chunks: chunks.length };
}

module.exports = { sendToZalo, chunkReport };
