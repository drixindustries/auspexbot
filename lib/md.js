// Telegram MarkdownV2 helpers. Every reserved character outside an entity must be escaped with "\".
// https://core.telegram.org/bots/api#markdownv2-style

const RESERVED = /[_*[\]()~`>#+\-=|{}.!\\]/g;

/** Escape plain text for MarkdownV2 (outside code spans / links). */
export function esc(value) {
  if (value == null) return "";
  return String(value).replace(RESERVED, "\\$&");
}

/** Inline code span. Inside `code` only ` and \ need escaping. */
export function code(value) {
  return "`" + String(value ?? "").replace(/[`\\]/g, "\\$&") + "`";
}

/** Inline link. Inside the (url) part only ) and \ need escaping. */
export function link(text, url) {
  return `[${esc(text)}](${String(url).replace(/[)\\]/g, "\\$&")})`;
}

export function bold(text) {
  return `*${esc(text)}*`;
}

export function italic(text) {
  return `_${esc(text)}_`;
}

/**
 * Best-effort MarkdownV2 validator used by tests: returns a list of problems (empty = ok).
 * Checks for unescaped reserved characters outside code spans and link URLs, and balanced * _ entities.
 */
export function validateMarkdownV2(text) {
  const problems = [];
  let i = 0;
  const stack = [];
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") { i += 2; continue; }
    if (text.startsWith("```", i)) {
      let j = i + 3, end = -1;
      for (; j < text.length; j++) { if (text[j] === "\\") { j++; continue; } if (text.startsWith("```", j)) { end = j; break; } }
      if (end < 0) { problems.push(`unterminated pre block at ${i}`); break; }
      i = end + 3; continue;
    }
    if (ch === "`") {
      const end = findUnescaped(text, "`", i + 1);
      if (end < 0) { problems.push(`unterminated code span at ${i}`); break; }
      i = end + 1; continue;
    }
    if (ch === "[") {
      const close = findUnescaped(text, "]", i + 1);
      if (close > 0 && text[close + 1] === "(") {
        const urlEnd = findUnescaped(text, ")", close + 2);
        if (urlEnd < 0) { problems.push(`unterminated link url at ${i}`); break; }
        problems.push(...validateMarkdownV2(text.slice(i + 1, close)).map((p) => `in link text: ${p}`));
        i = urlEnd + 1; continue;
      }
      problems.push(`unescaped '[' at ${i}`); i++; continue;
    }
    if (ch === "*" || ch === "_" || ch === "~" || ch === "|") {
      const tok = ch === "|" ? (text[i + 1] === "|" ? "||" : null) : ch;
      if (!tok) { problems.push(`unescaped '|' at ${i}`); i++; continue; }
      if (stack[stack.length - 1] === tok) stack.pop(); else stack.push(tok);
      i += tok.length; continue;
    }
    if ("]()>#+-=|{}.!".includes(ch)) problems.push(`unescaped '${ch}' at ${i}: …${text.slice(Math.max(0, i - 20), i + 5)}…`);
    i++;
  }
  if (stack.length) problems.push(`unbalanced entities: ${stack.join(" ")}`);
  return problems;
}

function findUnescaped(text, ch, from) {
  for (let j = from; j < text.length; j++) {
    if (text[j] === "\\") { j++; continue; }
    if (text[j] === ch) return j;
  }
  return -1;
}
