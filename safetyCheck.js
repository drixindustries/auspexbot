/**
 * GoPlus Security API — token safety check
 * Free, no API key required.
 * Chain ID 8453 = Base mainnet
 */

const GOPLUS_BASE = "https://api.gopluslabs.io/api/v1";
const BASE_CHAIN_ID = "8453";

/**
 * Fetch safety data for a Base token.
 * Returns a normalized safety object.
 */
export async function fetchSafety(tokenAddress) {
  try {
    const url = `${GOPLUS_BASE}/token_security/${BASE_CHAIN_ID}?contract_addresses=${tokenAddress.toLowerCase()}`;
    const res = await fetch(url, {
      headers: { "User-Agent": "AuspexBot/1.0" },
    });

    if (!res.ok) return null;

    const json = await res.json();
    const d    = json?.result?.[tokenAddress.toLowerCase()];
    if (!d) return null;

    const buyTax   = parseFloat(d.buy_tax   ?? 0) * 100;
    const sellTax  = parseFloat(d.sell_tax  ?? 0) * 100;
    const isHoneypot    = d.is_honeypot    === "1";
    const isOpenSource  = d.is_open_source === "1";
    const isMintable    = d.is_mintable    === "1";
    const canTakeBack   = d.can_take_back_ownership === "1";
    const ownerPercent  = parseFloat(d.owner_percent ?? 0) * 100;
    const creatorPercent = parseFloat(d.creator_percent ?? 0) * 100;

    // LP lock info
    const lpHolders    = d.lp_holders || [];
    const lockedLP     = lpHolders.some(h => h.is_locked === 1);
    const lpLockPct    = lpHolders
      .filter(h => h.is_locked === 1)
      .reduce((sum, h) => sum + parseFloat(h.percent || 0) * 100, 0);

    // Composite safety score (0-10, higher = safer)
    let score = 10;
    if (isHoneypot)         score -= 5;
    if (!isOpenSource)      score -= 1;
    if (isMintable)         score -= 1;
    if (canTakeBack)        score -= 1;
    if (buyTax > 10)        score -= 1;
    if (sellTax > 10)       score -= 1;
    if (ownerPercent > 5)   score -= 1;
    if (!lockedLP)          score -= 1;
    score = Math.max(0, Math.min(10, score));

    // Safety verdict
    let verdict, verdictEmoji;
    if (isHoneypot)   { verdict = "HONEYPOT";  verdictEmoji = "🚫"; }
    else if (score >= 8) { verdict = "SAFE";   verdictEmoji = "✅"; }
    else if (score >= 5) { verdict = "CAUTION"; verdictEmoji = "⚠️"; }
    else                 { verdict = "RISKY";   verdictEmoji = "🔴"; }

    return {
      score,
      verdict,
      verdictEmoji,
      isHoneypot,
      isOpenSource,
      isMintable,
      canTakeBack,
      buyTax:       Math.round(buyTax * 10) / 10,
      sellTax:      Math.round(sellTax * 10) / 10,
      ownerPercent: Math.round(ownerPercent * 10) / 10,
      lockedLP,
      lpLockPct:    Math.round(lpLockPct * 10) / 10,
    };
  } catch (err) {
    console.error("GoPlus safety check failed:", err.message);
    return null;
  }
}
