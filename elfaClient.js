/**
 * Elfa AI API client
 * Fetches smart follower weight and account stats for X accounts.
 *
 * Endpoint: GET /v2/account/smart-stats?username={handle}
 * Auth:     x-elfa-api-key header
 * Docs:     https://docs.elfa.ai
 *
 * Free tier: 1,000 credits/month
 * Grow tier: $290/month, 100,000 credits/month
 *
 * Smart followers = accounts that consistently demonstrate insight
 * (builders, researchers, traders, on-chain investigators)
 */

const ELFA_BASE = "https://api.elfa.ai";

// In-memory cache — avoids burning credits on repeated lookups
// for the same account within the same poll cycle
const statsCache = new Map(); // username → { data, cachedAt }
const CACHE_TTL_MS = 30 * 60 * 1000; // 30 minutes

export function elfaAvailable() {
  return Boolean(process.env.ELFA_API_KEY);
}

/**
 * Fetch smart follower stats for an X account.
 *
 * Returns:
 * {
 *   smartFollowerCount: number,
 *   followerCount:      number,
 *   engagementRate:     number,  // 0-1
 *   reach:              number,
 *   smartScore:         number,  // 0-100, derived
 *   influenceTier:      string,  // "TOP 1%" | "TOP 5%" | "TOP 10%" | "TOP 25%" | "EMERGING"
 * }
 *
 * Returns null if Elfa not configured or request fails.
 */
export async function getSmartStats(username) {
  if (!elfaAvailable()) return null;

  const clean = username.replace(/^@/, "").toLowerCase();

  // Check cache
  const cached = statsCache.get(clean);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const url = new URL(`${ELFA_BASE}/v2/account/smart-stats`);
    url.searchParams.set("username", clean);

    const res = await fetch(url.toString(), {
      headers: {
        "x-elfa-api-key": process.env.ELFA_API_KEY,
        "Accept":          "application/json",
      },
    });

    if (res.status === 404) {
      // Account not found in Elfa — not an error, just no data
      return null;
    }

    if (res.status === 429) {
      console.warn("Elfa API rate limited — skipping smart stats");
      return null;
    }

    if (!res.ok) {
      console.error(`Elfa API error ${res.status} for @${clean}`);
      return null;
    }

    const json = await res.json();

    if (!json.success || !json.data) return null;

    const d = json.data;

    const smartFollowerCount = d.smartFollowerCount ?? d.smart_follower_count ?? 0;
    const followerCount      = d.followerCount      ?? d.follower_count      ?? 0;
    const engagementRate     = d.engagementRate     ?? d.engagement_rate     ?? 0;
    const reach              = d.reach              ?? 0;

    // Derive a 0-100 smart score from the raw data
    // Weighted: smart followers (60%) + engagement rate (25%) + reach (15%)
    // Normalised against reasonable upper bounds
    const smartScore = Math.min(
      Math.round(
        Math.min(smartFollowerCount / 1000, 1) * 100 * 0.60 +
        Math.min(engagementRate * 10, 1)        * 100 * 0.25 +
        Math.min(reach / 100_000, 1)             * 100 * 0.15
      ),
      100
    );

    // Influence tier based on smart score
    const influenceTier = deriveInfluenceTier(smartScore, smartFollowerCount);

    const result = {
      smartFollowerCount,
      followerCount,
      engagementRate,
      reach,
      smartScore,
      influenceTier,
    };

    // Cache it
    statsCache.set(clean, { data: result, cachedAt: Date.now() });

    return result;
  } catch (err) {
    console.error(`Elfa smart stats failed for @${clean}:`, err.message);
    return null;
  }
}

/**
 * Batch fetch smart stats for multiple accounts.
 * Respects rate limits by spacing requests 100ms apart.
 * Returns Map of username → stats (null if failed).
 */
export async function batchGetSmartStats(usernames) {
  const results = new Map();
  if (!elfaAvailable()) return results;

  for (const username of usernames) {
    const stats = await getSmartStats(username);
    results.set(username.toLowerCase().replace(/^@/, ""), stats);
    // Small delay to stay under 100 req/min rate limit
    await new Promise((r) => setTimeout(r, 150));
  }

  return results;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function deriveInfluenceTier(smartScore, smartFollowerCount) {
  // Tier based on combination of score and raw smart follower count
  if (smartScore >= 80 || smartFollowerCount >= 500)  return "TOP 1%";
  if (smartScore >= 60 || smartFollowerCount >= 200)  return "TOP 5%";
  if (smartScore >= 40 || smartFollowerCount >= 100)  return "TOP 10%";
  if (smartScore >= 20 || smartFollowerCount >= 50)   return "TOP 25%";
  if (smartScore >= 10 || smartFollowerCount >= 10)   return "EMERGING";
  return "UNRANKED";
}
