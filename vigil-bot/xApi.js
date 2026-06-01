/**
 * X (Twitter) API v2 client
 * Uses app-only Bearer token auth (Basic tier required)
 * Endpoint: GET /2/users/:id/following
 */

const X_API_BASE = "https://api.twitter.com/2";

function getBearerToken() {
  return process.env.X_BEARER_TOKEN || null;
}

export function xApiAvailable() {
  return Boolean(getBearerToken());
}

/**
 * Make an authenticated request to X API v2.
 */
async function xFetch(path, params = {}) {
  const token = getBearerToken();
  if (!token) throw new Error("X_BEARER_TOKEN not set");

  const url = new URL(`${X_API_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, v);
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      "User-Agent":  "VigilBot/1.0",
    },
  });

  // Rate limited
  if (res.status === 429) {
    const reset = res.headers.get("x-rate-limit-reset");
    const waitMs = reset ? (parseInt(reset) * 1000 - Date.now()) : 60_000;
    throw new RateLimitError(`X API rate limited. Resets in ${Math.ceil(waitMs / 1000)}s`, waitMs);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`X API error ${res.status}: ${body.slice(0, 200)}`);
  }

  return res.json();
}

/**
 * Resolve a Twitter handle to a numeric user ID.
 * Caches results in memory to avoid repeated lookups.
 */
const userIdCache = new Map(); // handle → { id, name, username }

export async function resolveHandle(handle) {
  const clean = handle.replace(/^@/, "").toLowerCase();

  if (userIdCache.has(clean)) return userIdCache.get(clean);

  const data = await xFetch(`/users/by/username/${clean}`, {
    "user.fields": "id,name,username,public_metrics,description,created_at",
  });

  if (!data?.data) throw new Error(`User @${clean} not found on X`);

  const user = {
    id:          data.data.id,
    name:        data.data.name,
    username:    data.data.username,
    bio:         data.data.description || "",
    followers:   data.data.public_metrics?.followers_count ?? 0,
    following:   data.data.public_metrics?.following_count ?? 0,
    createdAt:   data.data.created_at,
  };

  userIdCache.set(clean, user);
  return user;
}

/**
 * Fetch the full following list for a user ID.
 * Paginates automatically up to 1000 accounts.
 * Returns array of { id, username, name, bio, followers }
 */
export async function fetchFollowing(userId) {
  const following = [];
  let paginationToken = null;

  do {
    const params = {
      max_results:   1000,
      "user.fields": "id,name,username,description,public_metrics,created_at",
    };
    if (paginationToken) params.pagination_token = paginationToken;

    const data = await xFetch(`/users/${userId}/following`, params);

    if (!data?.data) break;

    for (const u of data.data) {
      following.push({
        id:        u.id,
        username:  u.username?.toLowerCase(),
        name:      u.name,
        bio:       u.description || "",
        followers: u.public_metrics?.followers_count ?? 0,
        createdAt: u.created_at,
      });
    }

    paginationToken = data.meta?.next_token || null;
  } while (paginationToken);

  return following;
}

/**
 * Fetch recent tweets for a user (up to 5) for the alert preview.
 */
export async function fetchRecentTweets(userId, count = 5) {
  try {
    const data = await xFetch(`/users/${userId}/tweets`, {
      max_results:   count,
      "tweet.fields": "created_at,text",
      exclude:        "retweets,replies",
    });
    return data?.data?.map((t) => t.text) || [];
  } catch {
    return [];
  }
}

// ── Custom error for rate limiting ────────────────────────────────────────

export class RateLimitError extends Error {
  constructor(message, waitMs) {
    super(message);
    this.name    = "RateLimitError";
    this.waitMs  = waitMs;
  }
}
