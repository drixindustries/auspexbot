// Local mock of the Telegram Bot API for end-to-end tests. Nothing leaves the machine.
//   Bot side:   POST/GET /bot<token>/<method>   (point the bot at it with TELEGRAM_API_ROOT)
//   Test side:  POST /_update {message|callback_query}  — queue an update for getUpdates
//               GET  /_sent                             — every outgoing call the bot made
//               POST /_reset
// sendMessage / editMessageText with parse_mode MarkdownV2 are validated like Telegram does: an invalid
// entity returns 400 "can't parse entities", so escaping bugs surface in tests.
import http from "node:http";
import { validateMarkdownV2 } from "../../lib/md.js";

const port = Number(process.argv[2] || process.env.MOCK_TG_PORT || 56440);
let updates = [];
let nextUpdateId = 1;
let nextMessageId = 1000;
let sent = [];
const waiters = [];

function parseBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const buf = Buffer.concat(chunks);
      const ct = req.headers["content-type"] || "";
      if (ct.includes("application/json")) { try { return resolve(JSON.parse(buf.toString() || "{}")); } catch { return resolve({}); } }
      if (ct.includes("multipart/form-data")) {
        const boundary = ct.split("boundary=")[1];
        const out = {};
        for (const part of buf.toString("latin1").split("--" + boundary)) {
          const m = part.match(/name="([^"]+)"(?:; filename="([^"]+)")?\r\n(?:Content-Type: [^\r]+\r\n)?\r\n([\s\S]*)\r\n$/);
          if (m) out[m[1]] = m[2] ? { filename: m[2], bytes: Buffer.byteLength(m[3], "latin1") } : Buffer.from(m[3], "latin1").toString("utf8");
        }
        return resolve(out);
      }
      resolve(Object.fromEntries(new URLSearchParams(buf.toString())));
    });
  });
}

function json(res, code, body) {
  // explicit Content-Length: node-fetch v2 (used by Telegraf) reports "Premature close" on chunked bodies
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": buf.length, Connection: "close" });
  res.end(buf);
}

const BOT = { id: 7000000001, is_bot: true, first_name: "Auspex Test Bot", username: "auspex_test_bot" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname === "/_update" && req.method === "POST") {
    const u = await parseBody(req);
    const update = { update_id: nextUpdateId++, ...u };
    if (update.message && !update.message.message_id) update.message.message_id = nextMessageId++;
    if (update.message && !update.message.date) update.message.date = Math.floor(Date.now() / 1000);
    updates.push(update);
    while (waiters.length) waiters.shift()();
    return json(res, 200, { ok: true, update_id: update.update_id });
  }
  if (url.pathname === "/_sent") return json(res, 200, sent);
  if (url.pathname === "/_reset") { sent = []; updates = []; return json(res, 200, { ok: true }); }

  const m = url.pathname.match(/^\/bot([^/]+)\/(\w+)$/);
  if (!m) return json(res, 404, { ok: false, error_code: 404, description: "Not Found" });
  const method = m[2];
  const body = { ...Object.fromEntries(url.searchParams), ...(await parseBody(req)) };

  if (method === "getUpdates") {
    const offset = Number(body.offset || 0);
    const pending = () => updates.filter((u) => u.update_id >= offset);
    if (!pending().length) await new Promise((r) => { waiters.push(r); setTimeout(r, 1000); });
    updates = updates.filter((u) => u.update_id >= offset);
    return json(res, 200, { ok: true, result: pending() });
  }
  const record = { method, at: new Date().toISOString(), ...body };
  if (["sendMessage", "editMessageText", "sendPhoto"].includes(method) && body.parse_mode === "MarkdownV2") {
    const problems = validateMarkdownV2(String(body.text ?? body.caption ?? ""));
    if (problems.length) {
      sent.push({ ...record, rejected: true, problems });
      return json(res, 400, { ok: false, error_code: 400, description: "Bad Request: can't parse entities: " + problems[0] });
    }
  }
  sent.push(record);
  switch (method) {
    case "getMe": return json(res, 200, { ok: true, result: BOT });
    case "deleteWebhook": case "setMyCommands": case "sendChatAction": case "answerCallbackQuery":
    case "deleteMessage": case "banChatMember": case "unbanChatMember":
      return json(res, 200, { ok: true, result: true });
    case "getChatMember":
      return json(res, 200, { ok: true, result: { status: String(body.user_id) === String(process.env.MOCK_ADMIN_ID || "") ? "administrator" : "member", user: { id: Number(body.user_id) } } });
    case "createChatInviteLink":
      return json(res, 200, { ok: true, result: { invite_link: "https://t.me/+mockInvite", creator: BOT, is_primary: false, is_revoked: false } });
    case "sendMessage": case "sendPhoto": case "editMessageText":
      return json(res, 200, { ok: true, result: { message_id: nextMessageId++, date: Math.floor(Date.now() / 1000), chat: { id: Number(body.chat_id) || 0, type: "private" }, text: body.text || body.caption || "" } });
    default:
      return json(res, 200, { ok: true, result: true });
  }
}).listen(port, "127.0.0.1", () => console.log(`mock Telegram Bot API on :${port}`));
