import * as cheerio from "cheerio";

/**
 * Port of the reference's analyzers/locale.py. Computed via cheerio on
 * the already-stored renderedDomHtml at analyze time, rather than
 * needing new crawl-time columns — same pattern as reportAnalysis.ts.
 */

export function extractLocaleSignals(html: string): { lang: string | null; hreflang: { locale: string; url: string }[] } {
  const $ = cheerio.load(html);
  const lang = $("html").attr("lang") || null;
  const hreflang: { locale: string; url: string }[] = [];
  $('link[rel="alternate"][hreflang]').each((_, el) => {
    const locale = $(el).attr("hreflang");
    const href = $(el).attr("href");
    if (locale && href) hreflang.push({ locale, url: href });
  });
  return { lang, hreflang };
}

export type LocaleResult = {
  isMultilingual: boolean;
  langAttributeCounts: Record<string, number>;
  pagesWithoutLang: number;
  hreflangLocaleCounts: Record<string, number>;
  pagesWithHreflang: number;
  brokenHreflangCount: number;
  brokenHreflangExamples: { fromPage: string; locale: string; targetUrl: string }[];
};

export function runLocaleAnalysis(
  pages: { url: string; statusCode: number | null; lang: string | null; hreflang: { locale: string; url: string }[] }[],
  allCrawledUrls: Set<string>,
): LocaleResult {
  const realPages = pages.filter((p) => p.statusCode !== null && p.statusCode < 400);

  const langCounts = new Map<string, number>();
  let pagesWithoutLang = 0;
  for (const p of realPages) {
    if (p.lang) langCounts.set(p.lang, (langCounts.get(p.lang) ?? 0) + 1);
    else pagesWithoutLang++;
  }

  const hreflangLocaleCounts = new Map<string, number>();
  const brokenHreflang: { fromPage: string; locale: string; targetUrl: string }[] = [];
  let pagesWithHreflang = 0;

  for (const p of realPages) {
    if (!p.hreflang.length) continue;
    pagesWithHreflang++;
    for (const { locale, url } of p.hreflang) {
      hreflangLocaleCounts.set(locale, (hreflangLocaleCounts.get(locale) ?? 0) + 1);
      if (!allCrawledUrls.has(url)) {
        brokenHreflang.push({ fromPage: p.url, locale, targetUrl: url });
      }
    }
  }

  const isMultilingual = langCounts.size > 1 || hreflangLocaleCounts.size > 1;

  return {
    isMultilingual,
    langAttributeCounts: Object.fromEntries(langCounts),
    pagesWithoutLang,
    hreflangLocaleCounts: Object.fromEntries(hreflangLocaleCounts),
    pagesWithHreflang,
    brokenHreflangCount: brokenHreflang.length,
    brokenHreflangExamples: brokenHreflang.slice(0, 15),
  };
}
