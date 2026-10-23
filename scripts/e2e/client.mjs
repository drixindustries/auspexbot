// Test-side helpers for the mock Telegram API.
const ROOT = process.env.MOCK_TG || "http://127.0.0.1:56440";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function sent() { return (await fetch(`${ROOT}/_sent`)).json(); }
export async function reset() { await fetch(`${ROOT}/_reset`, { method: "POST" }); }

export async function update(u) {
  return (await fetch(`${ROOT}/_update`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(u) })).json();
}

/** Send a text message as a user and return the bot calls it triggered (waits until quiet). */
export async function say(text, { userId = 501, username = "drix_test", chatId = null, chatType = "private", title, waitMs = 1500, settleMs = 15000 } = {}) {
  const before = (await sent()).length;
  const chat = chatType === "private" ? { id: chatId ?? userId, type: "private", username } : { id: chatId, type: chatType, title: title || "Test group" };
  const entities = text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0].length }] : undefined;
  await update({ message: { from: { id: userId, is_bot: false, first_name: "Drix", username }, chat, text, entities } });
  // wait until the bot stops producing calls for waitMs (bounded by settleMs)
  const t0 = Date.now();
  let last = before, quietSince = Date.now();
  while (Date.now() - t0 < settleMs) {
    await sleep(250);
    const n = (await sent()).length;
    if (n !== last) { last = n; quietSince = Date.now(); }
    else if (n > before && Date.now() - quietSince > waitMs) break;
  }
  return (await sent()).slice(before).filter((c) => !["getUpdates", "sendChatAction", "answerCallbackQuery"].includes(c.method));
}

export function summarize(calls) {
  return calls.map((c) => `${c.rejected ? "❌ REJECTED by Telegram (400 can't parse entities): " + c.problems[0] + "\n   " : ""}[${c.method} → ${c.chat_id}] ${String(c.text ?? c.caption ?? (c.photo ? "<photo>" : "")).slice(0, 1500)}`).join("\n");
}
