/**
 * Real link-following under-discovers pages on many large sites — JS
 * pagination, "load more" buttons, and mega-menus that only render a
 * subset of links can all mean the homepage's single-render DOM
 * snapshot doesn't contain every path into the site. sitemap.xml is the
 * standard fix: site owners publish it specifically so crawlers don't
 * have to rely on navigation alone.
 *
 * Checks robots.txt for explicit `Sitemap:` directives first (the
 * correct, standard way a site points crawlers to its sitemap), falling
 * back to the conventional /sitemap.xml path. Handles both a sitemap
 * index (a sitemap of sitemaps) and a plain urlset, recursing one level
 * into an index. Capped and same-host-filtered so this can't balloon
 * into pulling in unrelated domains or an unbounded number of URLs.
 */

import { isLikelyNonHtmlResource } from "./urlFilters";

const MAX_SITEMAPS_TO_FETCH = 10;
const MAX_URLS_RETURNED = 2000;
const FETCH_TIMEOUT_MS = 8000;

async function fetchText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

function extractLocs(xml: string): string[] {
  const matches = xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi);
  return [...matches].map((m) => m[1]);
}

function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml);
}

export async function discoverSitemapUrls(startUrl: string): Promise<string[]> {
  let rootHost: string;
  try {
    rootHost = new URL(startUrl).host;
  } catch {
    return [];
  }

  const candidateSitemapUrls: string[] = [];

  const robotsTxt = await fetchText(new URL("/robots.txt", startUrl).toString());
  if (robotsTxt) {
    const sitemapLines = robotsTxt
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => /^sitemap:/i.test(l));
    for (const line of sitemapLines) {
      const url = line.split(":").slice(1).join(":").trim();
      if (url) candidateSitemapUrls.push(url);
    }
  }

  if (candidateSitemapUrls.length === 0) {
    candidateSitemapUrls.push(new URL("/sitemap.xml", startUrl).toString());
  }

  const discovered = new Set<string>();
  let sitemapsFetched = 0;

  for (const sitemapUrl of candidateSitemapUrls.slice(0, MAX_SITEMAPS_TO_FETCH)) {
    if (sitemapsFetched >= MAX_SITEMAPS_TO_FETCH || discovered.size >= MAX_URLS_RETURNED) break;
    const xml = await fetchText(sitemapUrl);
    if (!xml) continue;
    sitemapsFetched++;

    if (isSitemapIndex(xml)) {
      // One level of recursion into a sitemap index — enough for the
      // vast majority of real sites, which rarely nest sitemaps more
      // than one level deep (e.g. sitemap_index.xml -> sitemap-1.xml,
      // sitemap-2.xml, ...).
      const nestedSitemaps = extractLocs(xml).slice(0, MAX_SITEMAPS_TO_FETCH - sitemapsFetched);
      for (const nested of nestedSitemaps) {
        if (sitemapsFetched >= MAX_SITEMAPS_TO_FETCH || discovered.size >= MAX_URLS_RETURNED) break;
        const nestedXml = await fetchText(nested);
        if (!nestedXml) continue;
        sitemapsFetched++;
        for (const loc of extractLocs(nestedXml)) {
          try {
            if (new URL(loc).host === rootHost && !isLikelyNonHtmlResource(loc)) discovered.add(loc);
          } catch {
            /* skip unparseable entries */
          }
          if (discovered.size >= MAX_URLS_RETURNED) break;
        }
      }
    } else {
      for (const loc of extractLocs(xml)) {
        try {
          if (new URL(loc).host === rootHost && !isLikelyNonHtmlResource(loc)) discovered.add(loc);
        } catch {
          /* skip unparseable entries */
        }
        if (discovered.size >= MAX_URLS_RETURNED) break;
      }
    }
  }

  return [...discovered];
}
