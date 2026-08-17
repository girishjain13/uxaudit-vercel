import { Redis } from "@upstash/redis";

// Constructed lazily, on first use, for the same reason as lib/db/index.ts:
// Redis.fromEnv() validates UPSTASH_REDIS_REST_URL/TOKEN immediately, and
// Next.js's build-time "collecting page data" step imports this module
// (transitively, via the route handlers) before those env vars are
// necessarily relevant — an eager construction here crashed the build
// itself rather than just a request that actually needed Redis.
let _redis: Redis | null = null;

function getRedis(): Redis {
  if (_redis) return _redis;
  if (!process.env.UPSTASH_REDIS_REST_URL || !process.env.UPSTASH_REDIS_REST_TOKEN) {
    throw new Error(
      "UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are not set. Add them in Vercel's " +
        "Project Settings → Environment Variables, or in .env.local for local dev.",
    );
  }
  _redis = Redis.fromEnv();
  return _redis;
}

export const redis: Redis = new Proxy({} as Redis, {
  get(_target, prop, receiver) {
    return Reflect.get(getRedis() as object, prop, receiver);
  },
});

/**
 * Atomic "have we already queued this URL for this audit" check.
 * Replaces the original's `if link_url not in audit.seen_urls` — that
 * check was safe there because one process owned the whole in-memory
 * list; here, multiple /api/crawl/page invocations can discover the same
 * link at the same moment, so the check itself has to be atomic. SETNX
 * (via Redis `set` with `nx: true`) gives us that: only the first caller
 * to mark a URL "seen" gets `true` back and should enqueue it.
 */
export async function markSeenIfNew(auditId: string, url: string): Promise<boolean> {
  const key = `audit:${auditId}:seen:${url}`;
  // 24h TTL: long enough to cover a large audit's full run, short enough
  // not to accumulate forever across many audits.
  const result = await redis.set(key, "1", { nx: true, ex: 60 * 60 * 24 });
  return result === "OK";
}

/** Cache robots.txt fetch/parse per audit so every page-function invocation
 * doesn't refetch it. */
export async function getCachedRobots(auditId: string): Promise<string | null> {
  return redis.get(`audit:${auditId}:robots`);
}

export async function setCachedRobots(auditId: string, robotsTxt: string) {
  await redis.set(`audit:${auditId}:robots`, robotsTxt, { ex: 60 * 60 * 24 });
}

/**
 * Outstanding-page counter — incremented when a page is enqueued,
 * decremented when its crawl-function invocation finishes. Hitting zero
 * is how we detect "the crawl is done" without a loop watching a frontier,
 * since no single process is alive for the whole crawl to watch it.
 */
export async function incrOutstanding(auditId: string, by: number) {
  return redis.incrby(`audit:${auditId}:outstanding`, by);
}

export async function decrOutstandingAndCheckDone(auditId: string): Promise<boolean> {
  const remaining = await redis.decr(`audit:${auditId}:outstanding`);
  return remaining <= 0;
}
