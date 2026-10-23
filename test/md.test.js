import test from "node:test";
import assert from "node:assert/strict";
import { esc, code, link, bold, validateMarkdownV2 } from "../lib/md.js";

test("esc escapes every MarkdownV2 reserved char", () => {
  const s = "_*[]()~`>#+-=|{}.!\\";
  assert.deepEqual(validateMarkdownV2(esc(s)), []);
  assert.equal(esc("a.b"), "a\\.b");
});
test("code/link/bold produce valid entities", () => {
  assert.deepEqual(validateMarkdownV2(`${bold("x (y)")} ${code("a`b\\c")} ${link("t.me", "https://x.y/a?b=(c)")}`), []);
});
test("validator catches the original bot's bugs", () => {
  /* eslint-disable no-useless-escape -- reproducing the original bug on purpose */
  // what the original /help sent: "\(" inside a JS template literal is just "("
  assert.ok(validateMarkdownV2(`link X handle \($20/month\)`).length > 0);
  assert.ok(validateMarkdownV2("❌ No valid address found\.").length > 0);
  /* eslint-enable no-useless-escape */
  assert.deepEqual(validateMarkdownV2("ok \\. fine"), []);
});
