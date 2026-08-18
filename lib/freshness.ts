/**
 * Port of the reference's analyzers/freshness.py. Freshness data comes
 * from the HTTP Last-Modified response header only — the reference also
 * falls back to sitemap.xml's <lastmod>, which our crawler doesn't parse
 * (we don't currently seed/read sitemap.xml at all). Many real sites
 * provide neither reliably; that's itself worth reporting rather than
 * silently treating "unknown" as "old."
 */
const ONE_YEAR_DAYS = 365;
const THREE_YEAR_DAYS = 365 * 3;

export type FreshnessResult = {
  pagesWithKnownDate: number;
  pagesWithUnknownDate: number;
  unknownDatePct: number;
  staleOver1yrCount: number;
  staleOver1yrPct: number;
  staleOver3yrCount: number;
  staleOver3yrPct: number;
  stalestPages: { url: string; daysSinceUpdate: number }[];
};

export function runFreshnessAnalysis(
  pages: { url: string; statusCode: number | null; lastModified: string | null }[],
): FreshnessResult {
  const realPages = pages.filter((p) => p.statusCode !== null && p.statusCode < 400);
  const now = Date.now();

  const dated: { url: string; days: number }[] = [];
  for (const p of realPages) {
    if (!p.lastModified) continue;
    const ts = Date.parse(p.lastModified); // handles both RFC 1123 HTTP-date and ISO 8601
    if (Number.isNaN(ts)) continue;
    dated.push({ url: p.url, days: Math.round((now - ts) / 86_400_000) });
  }

  const unknownCount = realPages.length - dated.length;
  const stale1yr = dated.filter((d) => d.days > ONE_YEAR_DAYS);
  const stale3yr = dated.filter((d) => d.days > THREE_YEAR_DAYS);
  const sorted = [...dated].sort((a, b) => b.days - a.days);

  return {
    pagesWithKnownDate: dated.length,
    pagesWithUnknownDate: unknownCount,
    unknownDatePct: realPages.length ? Math.round((100 * unknownCount) / realPages.length * 10) / 10 : 0,
    staleOver1yrCount: stale1yr.length,
    staleOver1yrPct: dated.length ? Math.round((100 * stale1yr.length) / dated.length * 10) / 10 : 0,
    staleOver3yrCount: stale3yr.length,
    staleOver3yrPct: dated.length ? Math.round((100 * stale3yr.length) / dated.length * 10) / 10 : 0,
    stalestPages: sorted.slice(0, 15).map((d) => ({ url: d.url, daysSinceUpdate: d.days })),
  };
}
