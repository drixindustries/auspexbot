/**
 * Vigil Chart Renderer
 * Fetches OHLCV data from GeckoTerminal and renders a candlestick chart
 * as a PNG buffer using @napi-rs/canvas.
 */

import { createCanvas } from "@napi-rs/canvas";

const GECKO = "https://api.geckoterminal.com/api/v2";
const HEADERS = { Accept: "application/json;version=20230302" };

// ── OHLCV fetch ─────────────────────────────────────────────────────────────

/**
 * Fetch OHLCV candles for a pool.
 * Returns array of { t, o, h, l, c, v }
 */
export async function fetchOHLCV(poolAddress, timeframe = "hour", limit = 48) {
  const url = `${GECKO}/networks/base/pools/${poolAddress}/ohlcv/${timeframe}?limit=${limit}&currency=usd`;
  const res = await fetch(url, { headers: HEADERS });
  if (!res.ok) throw new Error(`OHLCV fetch failed: ${res.status}`);
  const json = await res.json();
  const raw  = json?.data?.attributes?.ohlcv_list || [];
  // GeckoTerminal returns [timestamp, open, high, low, close, volume]
  return raw.map(([t, o, h, l, c, v]) => ({
    t: t * 1000, // convert to ms
    o: parseFloat(o),
    h: parseFloat(h),
    l: parseFloat(l),
    c: parseFloat(c),
    v: parseFloat(v),
  })).reverse(); // oldest first
}

// ── Chart renderer ──────────────────────────────────────────────────────────

const W = 800;
const H = 420;
const PAD = { top: 40, right: 20, bottom: 60, left: 80 };
const CHART_W = W - PAD.left - PAD.right;
const CHART_H = H - PAD.top - PAD.bottom;

const COLORS = {
  bg:       "#0a0a0a",
  grid:     "#1a1a1a",
  text:     "#555",
  label:    "#888",
  up:       "#26a69a",
  down:     "#ef5350",
  volume:   "#ffffff18",
  baseline: "#333",
};

/**
 * Render a candlestick chart and return a PNG buffer.
 * @param {Array} candles - Array of { t, o, h, l, c, v }
 * @param {string} symbol - Token symbol for the title
 * @param {string} timeframe - "hour" | "day"
 */
export async function renderChart(candles, symbol, timeframe = "hour") {
  if (!candles || candles.length === 0) throw new Error("No candle data");

  const canvas = createCanvas(W, H);
  const ctx    = canvas.getContext("2d");

  // Background
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, H);

  // Price range
  const prices = candles.flatMap(c => [c.h, c.l]);
  const minP   = Math.min(...prices);
  const maxP   = Math.max(...prices);
  const priceRange = maxP - minP || maxP * 0.01;
  const pricePad   = priceRange * 0.08;

  const priceMin = minP - pricePad;
  const priceMax = maxP + pricePad;

  // Volume range
  const volumes = candles.map(c => c.v);
  const maxVol  = Math.max(...volumes) || 1;

  // Helpers
  const px = (price) => PAD.top + CHART_H - ((price - priceMin) / (priceMax - priceMin)) * CHART_H;
  const tx = (i)     => PAD.left + (i / (candles.length - 1)) * CHART_W;

  // Grid lines (5 horizontal)
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth   = 1;
  for (let i = 0; i <= 4; i++) {
    const y     = PAD.top + (i / 4) * CHART_H;
    const price = priceMax - (i / 4) * (priceMax - priceMin);
    ctx.beginPath();
    ctx.moveTo(PAD.left, y);
    ctx.lineTo(W - PAD.right, y);
    ctx.stroke();
    // Price label
    ctx.fillStyle  = COLORS.label;
    ctx.font       = "10px monospace";
    ctx.textAlign  = "right";
    ctx.fillText(formatChartPrice(price), PAD.left - 8, y + 4);
  }

  // Volume bars (bottom 20% of chart area)
  const volH  = CHART_H * 0.18;
  const volY0 = PAD.top + CHART_H - 1;

  for (let i = 0; i < candles.length; i++) {
    const c    = candles[i];
    const barW = Math.max(1, (CHART_W / candles.length) * 0.6);
    const x    = tx(i) - barW / 2;
    const bh   = (c.v / maxVol) * volH;
    ctx.fillStyle = c.c >= c.o ? COLORS.up + "44" : COLORS.down + "44";
    ctx.fillRect(x, volY0 - bh, barW, bh);
  }

  // Candlesticks
  const candleW = Math.max(1.5, (CHART_W / candles.length) * 0.55);

  for (let i = 0; i < candles.length; i++) {
    const c     = candles[i];
    const x     = tx(i);
    const isUp  = c.c >= c.o;
    const color = isUp ? COLORS.up : COLORS.down;

    const yOpen  = px(c.o);
    const yClose = px(c.c);
    const yHigh  = px(c.h);
    const yLow   = px(c.l);

    // Wick
    ctx.strokeStyle = color;
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(x, yHigh);
    ctx.lineTo(x, yLow);
    ctx.stroke();

    // Body
    const bodyTop = Math.min(yOpen, yClose);
    const bodyH   = Math.max(1, Math.abs(yClose - yOpen));
    ctx.fillStyle = color;
    ctx.fillRect(x - candleW / 2, bodyTop, candleW, bodyH);
  }

  // Title
  ctx.fillStyle  = "#e0e0e0";
  ctx.font       = "bold 14px monospace";
  ctx.textAlign  = "left";
  ctx.fillText(`$${symbol} · ${timeframe === "hour" ? "Hourly" : "Daily"}`, PAD.left, 24);

  // Timestamp labels (5 evenly spaced)
  ctx.fillStyle = COLORS.text;
  ctx.font      = "9px monospace";
  ctx.textAlign = "center";
  for (let i = 0; i <= 4; i++) {
    const idx = Math.round((i / 4) * (candles.length - 1));
    const x   = tx(idx);
    const d   = new Date(candles[idx].t);
    const lbl = timeframe === "hour"
      ? `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,"0")}:00`
      : `${d.getMonth()+1}/${d.getDate()}`;
    ctx.fillText(lbl, x, H - 12);
  }

  // Watermark
  ctx.fillStyle  = "#ffffff18";
  ctx.font       = "11px monospace";
  ctx.textAlign  = "right";
  ctx.fillText("Auspex", W - PAD.right, H - 12);

  return canvas.toBuffer("image/png");
}

/**
 * Render both hourly and daily charts stacked vertically.
 * Returns a single combined PNG buffer.
 */
export async function renderDualChart(hourlyCandles, dailyCandles, symbol) {
  const DUAL_H = H * 2 + 10;
  const canvas = createCanvas(W, DUAL_H);
  const ctx    = canvas.getContext("2d");

  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, W, DUAL_H);

  // Render each chart and composite
  const hourBuf = await renderChart(hourlyCandles, symbol, "hour");
  const dayBuf  = await renderChart(dailyCandles,  symbol, "day");

  // Draw both onto the combined canvas
  const { loadImage } = await import("@napi-rs/canvas");
  const hourImg = await loadImage(hourBuf);
  const dayImg  = await loadImage(dayBuf);

  ctx.drawImage(hourImg, 0, 0);
  ctx.drawImage(dayImg,  0, H + 10);

  return canvas.toBuffer("image/png");
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatChartPrice(n) {
  if (!n || isNaN(n)) return "0";
  if (n < 0.000001)   return n.toExponential(2);
  if (n < 0.001)      return n.toFixed(7);
  if (n < 1)          return n.toFixed(5);
  if (n < 1000)       return n.toFixed(2);
  return n.toFixed(0);
}
