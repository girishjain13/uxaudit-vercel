import { getCachedRobots, setCachedRobots } from "@/lib/redis";

/**
 * Port of app/crawler/robots.py's RobotsInfo, minus the sitemap-discovery
 * seeding step (that's folded into the initial /api/audits enqueue in this
 * rewrite rather than run mid-crawl). Cached in Redis per audit so every
 * page-crawl invocation isn't re-fetching robots.txt on its own.
 */
export async function loadRobots(auditId: string, startUrl: string): Promise<string> {
  const cached = await getCachedRobots(auditId);
  if (cached !== null) return cached;

  try {
    const robotsUrl = new URL("/robots.txt", startUrl).toString();
    const res = await fetch(robotsUrl, { signal: AbortSignal.timeout(5000) });
    const text = res.ok ? await res.text() : "";
    await setCachedRobots(auditId, text);
    return text;
  } catch {
    await setCachedRobots(auditId, "");
    return "";
  }
}

/**
 * Minimal disallow-rule check. TODO: this is a placeholder — swap in a
 * real robots.txt parser (e.g. the `robots-parser` npm package) before
 * relying on this for actual client audits; a naive prefix match doesn't
 * handle wildcards, $ end-anchors, or user-agent-specific rule blocks
 * correctly.
 */
export function canFetch(robotsTxt: string, url: string): boolean {
  if (!robotsTxt) return true;
  const path = new URL(url).pathname;
  const disallowLines = robotsTxt
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.toLowerCase().startsWith("disallow:"));
  return !disallowLines.some((line) => {
    const rule = line.split(":").slice(1).join(":").trim();
    return rule && path.startsWith(rule);
  });
}
