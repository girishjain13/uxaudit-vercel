/**
 * Direct port of the reference's analyzers/variance.py: a simple, honest
 * check against whatever number the client gave in discovery versus what
 * the crawl actually found. A big variance either way is worth asking
 * about before finalizing SOW scope, not something to silently paper over.
 */
export type VarianceResult = {
  clientStatedPageCount: number;
  crawledPageCount: number;
  difference: number;
  differencePct: number;
  note: string;
};

export function runVarianceAnalysis(
  clientStatedPageCount: number | null | undefined,
  crawledPageCount: number,
  crawlTruncated: boolean,
): VarianceResult | null {
  if (clientStatedPageCount == null) return null;

  const diff = crawledPageCount - clientStatedPageCount;
  const pctDiff = Math.round((100 * diff) / Math.max(clientStatedPageCount, 1) * 10) / 10;

  let note: string;
  if (crawlTruncated) {
    note =
      `This crawl was truncated at the per-run page limit, so the actual site is at least ` +
      `${crawledPageCount} pages — the comparison below understates the real total.`;
  } else if (Math.abs(pctDiff) <= 10) {
    note = "Within a reasonable margin of what the client stated — no major surprise here.";
  } else if (diff > 0) {
    note =
      "The crawl found meaningfully more pages than the client stated — worth asking whether this includes " +
      "content the client wasn't aware of (old campaign pages, an unlinked subsection, a forgotten subdomain).";
  } else {
    note =
      "The crawl found meaningfully fewer pages than the client stated — worth checking whether some of the " +
      "client's stated pages are blocked (robots.txt/WAF), behind a login this crawl couldn't reach, or simply " +
      "weren't discoverable from the homepage/sitemap.";
  }

  return {
    clientStatedPageCount,
    crawledPageCount,
    difference: diff,
    differencePct: pctDiff,
    note,
  };
}
