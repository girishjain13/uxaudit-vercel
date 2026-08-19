/**
 * We already recorded which external links exist during the crawl —
 * this is the missing half: actually checking whether they still
 * resolve. Bounded hard: a real site can accumulate hundreds of unique
 * external links, and checking every one live, on every export
 * request, isn't a reasonable tradeoff against Vercel's function time
 * limit. Capped to a fixed number of the most-linked external URLs
 * (the ones worth fixing first anyway) with limited concurrency and a
 * short per-request timeout.
 */

const MAX_LINKS_TO_CHECK = 30;
const CONCURRENCY = 5;
const TIMEOUT_MS = 5000;

export type ExternalLinkHealthResult = {
  url: string;
  status: number | string; // numeric HTTP status, or a string like "ConnectError" / "Timeout"
  linkedFromCount: number;
  exampleLinkingPage: string;
};

export async function checkExternalLinkHealth(
  links: { sourceUrl: string; targetUrl: string }[],
): Promise<ExternalLinkHealthResult[]> {
  const bySrc = new Map<string, { count: number; example: string }>();
  for (const { sourceUrl, targetUrl } of links) {
    const existing = bySrc.get(targetUrl);
    if (existing) existing.count++;
    else bySrc.set(targetUrl, { count: 1, example: sourceUrl });
  }

  // Check the most-linked external URLs first — a broken link referenced
  // from 10 pages matters more to fix than one referenced from a single page.
  const candidates = [...bySrc.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, MAX_LINKS_TO_CHECK);

  const results: ExternalLinkHealthResult[] = [];
  for (let i = 0; i < candidates.length; i += CONCURRENCY) {
    const batch = candidates.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async ([url, { count, example }]) => {
        const status = await checkOne(url);
        return { url, status, linkedFromCount: count, exampleLinkingPage: example };
      }),
    );
    results.push(...batchResults);
  }

  return results.filter((r) => typeof r.status === "string" || (typeof r.status === "number" && r.status >= 400));
}

async function checkOne(url: string): Promise<number | string> {
  try {
    // HEAD first — cheaper, and sufficient for a status check. Some
    // servers don't implement HEAD correctly (405/403 for a real,
    // working page) — fall back to GET in that case rather than
    // reporting a false positive.
    const headRes = await fetch(url, { method: "HEAD", redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (headRes.status !== 405 && headRes.status !== 403) return headRes.status;
    const getRes = await fetch(url, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(TIMEOUT_MS) });
    return getRes.status;
  } catch (err) {
    if (err instanceof Error && err.name === "TimeoutError") return "Timeout";
    return "ConnectError";
  }
}
