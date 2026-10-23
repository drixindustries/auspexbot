// Parity: run the SITE's own badge renderers (auspex-site index.html) on the same payload and check that
// every badge the bot shows appears on the site for that coin, with the same text, and that the security-
// relevant badges (bad-actor, good-dev, RugCheck insights, RugCheck tier) match exactly.
// Needs a checkout of auspex-site: AUSPEX_SITE_HTML=/path/to/auspex-site/index.html (skipped otherwise).
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { buildPayload } from "./fixtures/synthetic.js";
import { signalItems, launchItems, graduationItems } from "../lib/normalize.js";
import { badgesFor } from "../lib/badges.js";

const HTML = process.env.AUSPEX_SITE_HTML;
const skip = !HTML || !fs.existsSync(HTML) ? "set AUSPEX_SITE_HTML to auspex-site/index.html" : false;

// The site is one IIFE; run its body in a sandbox with an inert DOM and hand back the renderers.
function loadSite(html) {
  const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).sort((a, b) => b.length - a.length)[0];
  const body = script.trim().replace(/^\(function \(\) \{/, "").replace(/\}\)\(\);?\s*$/, "");
  const stub = new Proxy(function () {}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => "" : k === "then" ? undefined : stub), apply: () => stub, construct: () => stub, set: () => true });
  const panels = {};
  const element = (id) => panels[id] || (panels[id] = new Proxy({ innerHTML: "" }, { get: (t, k) => (k in t ? t[k] : stub), set: (t, k, v) => { t[k] = v; return true; } }));
  const ctx = {
    document: new Proxy({}, { get: (_t, k) => (k === "getElementById" ? element : stub) }),
    window: stub, localStorage: stub, navigator: stub, location: stub,
    fetch: () => new Promise(() => {}), setInterval: () => 0, setTimeout: () => 0, clearInterval() {}, clearTimeout() {},
    console, URLSearchParams,
  };
  vm.createContext(ctx);
  const api = vm.runInContext(`(function () {${body}\n;return { renderSignalRowHTML, renderLaunchedPanel, renderGraduatedPanel };})()`, ctx);
  return { ctx: api, panels };
}

const decode = (s) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
const spans = (html) => [...html.matchAll(/<span class="mono tag"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => decode(m[1]));
const SECURITY = /SANCTIONED|RUG DEV|HEURISTIC LIST|PROVEN DEV|PROMISING DEV|RUGGED|INSIDERS|SERIAL LAUNCHER|🏷|^🟢 SAFE|^🟡 CAUTION|^🔴 DANGER/;
const norm = (t) => t.replace(/ · (just now|\d+m ago)$/, "");

export const counted = { badges: 0, security: 0 };
function compare(kind, item, siteHtml) {
  const site = spans(siteHtml).map(norm);
  const mine = badgesFor(item).map((b) => b.text);
  for (const t of mine) assert.ok(site.includes(t), `${kind} ${item.symbol || item.address}: bot badge "${t}" not on site [${site.join(" | ")}]`);
  const siteSec = site.filter((t) => SECURITY.test(t));
  const mineSec = mine.filter((t) => SECURITY.test(t));
  assert.deepEqual(mineSec, siteSec, `${kind} ${item.symbol || item.address}: security badges differ`);
  counted.badges += mine.length; counted.security += mineSec.length;
}

test.after(() => { if (!skip) { console.log(`# parity: compared ${counted.badges} badges (${counted.security} security badges) against the site`); assert.ok(counted.security > 20); } });

test("signal rows: bot badges == site badges", { skip }, () => {
  const { ctx } = loadSite(fs.readFileSync(HTML, "utf8"));
  const p = buildPayload(Date.now());
  const items = signalItems(p);
  assert.ok(items.length > 10);
  for (const it of items) {
    const r = Object.values(p.chainGroups).flat().find((x) => x && x.tokenAddress === it.address && (x.chainId || it.chain) === it.chain);
    const html = ctx.renderSignalRowHTML(r, 0, it.chain, p.kolBuys || {}, p.lunarSignals || {}, p.rugSafety || {}, p.signalCreatorFlags || {});
    compare("signal", it, html);
  }
});

test("launch and graduation panels: bot badges == site badges", { skip }, () => {
  const p = buildPayload(Date.now());
  for (const [kind, items, render, arr] of [["launch", launchItems(p), "renderLaunchedPanel", p.justLaunched], ["graduation", graduationItems(p), "renderGraduatedPanel", p.justGraduated]]) {
    for (const it of items) {
      const { ctx, panels } = loadSite(fs.readFileSync(HTML, "utf8"));
      const raw = arr.find((x) => x.mint === it.address);
      if (kind === "launch") ctx[render]([raw], p.badActorSources || []); else ctx[render]([raw]);
      const html = Object.values(panels).map((x) => x.innerHTML).join("");
      assert.ok(html.length > 0, `${render} rendered nothing`);
      compare(kind, it, html);
    }
  }
});
