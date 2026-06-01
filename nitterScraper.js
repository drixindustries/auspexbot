/**
 * Nitter scraper — fallback for X API rate limits or outages.
 * Tries multiple public Nitter instances in order.
 * Parses the /following page HTML to extract accounts.
 */

const NITTER_INSTANCES = [
  "https://nitter.poast.org",
  "https://nitter.cz",
  "https://nitter.privacydev.net",
  "https://nitter.1d4.us",
];

const TIMEOUT_MS = 8_000;

/**
 * Fetch with timeout.
 */
async function fetchWithTimeout(url, timeoutMs = TIMEOUT_MS) {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal:  controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; VigilBot/1.0)",
        Accept:       "text/html",
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Try fetching the following page from each Nitter instance.
 * Returns { html, instance } or throws if all fail.
 */
async function fetchFollowingPage(handle) {
  const clean = handle.replace(/^@/, "");

  for (const instance of NITTER_INSTANCES) {
    try {
      const res = await fetchWithTimeout(`${instance}/${clean}/following`);
      if (!res.ok) continue;
      const html = await res.text();
      // Verify it looks like a real Nitter page
      if (html.includes("timeline-item") || html.includes("profile-card")) {
        return { html, instance };
      }
    } catch (err) {
      // Instance down or timed out — try next
      console.warn(`Nitter ${instance} failed: ${err.message}`);
    }
  }

  throw new Error("All Nitter instances failed");
}

/**
 * Parse following list from Nitter HTML.
 * Returns array of { username, name, bio, followers }
 */
function parseFollowingHtml(html) {
  const accounts = [];

  // Match each profile card block
  // Nitter profile cards look like:
  // <div class="timeline-item"> ... <a href="/username"> ... </div>
  const cardPattern = /<div class="(?:timeline-item|profile-card)"[^>]*>([\s\S]*?)<\/div>\s*(?=<div class="(?:timeline-item|profile-card)|<\/div>)/g;

  // Simpler approach: extract all href="/username" patterns and associated data
  // Find all account links on the following page
  const usernamePattern = /href="\/([A-Za-z0-9_]{1,50})"[^>]*class="[^"]*(?:username|fullname)[^"]*"/g;
  const altUsernamePattern = /class="[^"]*(?:username|fullname)[^"]*"[^>]*href="\/([A-Za-z0-9_]{1,50})"/g;

  const seen = new Set();

  // Extract usernames from href patterns
  let match;
  const allPattern = /href="\/([A-Za-z0-9_]{1,50})"[^>]*>(?:@[A-Za-z0-9_]+|<[^>]+>@?([A-Za-z0-9_]+))/g;

  while ((match = allPattern.exec(html)) !== null) {
    const username = match[1].toLowerCase();
    // Skip navigation/UI links
    if (["search", "login", "settings", "about", "i"].includes(username)) continue;
    if (seen.has(username)) continue;
    seen.add(username);
    accounts.push({ username, name: username, bio: "", followers: 0 });
  }

  // If that didn't work, try a more aggressive extract
  if (accounts.length === 0) {
    const hrefPattern = /href="\/([A-Za-z0-9_]{4,50})"/g;
    while ((match = hrefPattern.exec(html)) !== null) {
      const username = match[1].toLowerCase();
      if (["search", "login", "settings", "about", "i", "following", "followers"].includes(username)) continue;
      if (seen.has(username)) continue;
      seen.add(username);
      accounts.push({ username, name: username, bio: "", followers: 0 });
    }
  }

  return accounts;
}

/**
 * Main export: fetch following list for a handle via Nitter.
 * Returns array of { username, name, bio, followers }
 */
export async function fetchFollowingNitter(handle) {
  const { html, instance } = await fetchFollowingPage(handle);
  const accounts           = parseFollowingHtml(html);

  if (accounts.length === 0) {
    throw new Error(`Nitter returned 0 accounts for @${handle} (parse may have failed)`);
  }

  console.log(`Nitter (${instance}): found ${accounts.length} following for @${handle}`);
  return accounts;
}

/**
 * Check if Nitter is reachable at all.
 */
export async function nitterHealthCheck() {
  for (const instance of NITTER_INSTANCES) {
    try {
      const res = await fetchWithTimeout(`${instance}/x`, 5000);
      if (res.ok || res.status === 404) return instance; // 404 is fine, means it's up
    } catch {}
  }
  return null;
}
