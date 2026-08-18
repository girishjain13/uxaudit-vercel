/**
 * Port of the reference's analyzers/url_health.py — with one honest gap:
 * that source tracks redirect_chain/redirect_chain_length per page,
 * which requires the crawler itself to record each hop of a redirect.
 * Our Browserless-based renderer calls page.goto() and only sees the
 * FINAL response after Chromium follows redirects internally — no
 * intermediate-hop data is available without a meaningfully different
 * fetch strategy (e.g. following redirects manually with
 * redirect: "manual"). That part of url_health.py is not ported here.
 *
 * Everything else — non-canonical URL pattern detection (trailing slash
 * / case inconsistencies, tracking-param bloat) — needs nothing but the
 * URLs already crawled, and is ported faithfully below.
 */

const TRACKING_PARAM_PREFIXES = ["utm_"];
const TRACKING_PARAM_NAMES = new Set(["fbclid", "gclid", "msclkid", "mc_cid", "mc_eid"]);

function isTrackingParam(name: string): boolean {
  return TRACKING_PARAM_NAMES.has(name) || TRACKING_PARAM_PREFIXES.some((p) => name.startsWith(p));
}

export type UrlHealthResult = {
  trailingSlashInconsistencies: { pages: string[] }[];
  caseInconsistencies: { pages: string[] }[];
  paramBloatCount: number;
  paramBloatExamples: { url: string; paramCount: number }[];
  trackingParamCount: number;
  trackingParamExamples: { url: string; trackingParams: string[] }[];
};

export function runUrlHealthAnalysis(urls: string[]): UrlHealthResult {
  const byPathLowerNoSlash = new Map<string, Set<string>>();
  const paramBloatUrls: { url: string; paramCount: number }[] = [];
  const trackingParamUrls: { url: string; trackingParams: string[] }[] = [];

  for (const url of urls) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      continue;
    }
    const key = `${parsed.host.toLowerCase()}|${parsed.pathname.toLowerCase().replace(/\/$/, "")}`;
    if (!byPathLowerNoSlash.has(key)) byPathLowerNoSlash.set(key, new Set());
    byPathLowerNoSlash.get(key)!.add(url);

    const params = [...parsed.searchParams.keys()];
    if (params.length > 3) {
      paramBloatUrls.push({ url, paramCount: params.length });
    }
    const trackingFound = params.filter(isTrackingParam);
    if (trackingFound.length) {
      trackingParamUrls.push({ url, trackingParams: trackingFound });
    }
  }

  const trailingSlashInconsistencies: { pages: string[] }[] = [];
  const caseInconsistencies: { pages: string[] }[] = [];

  for (const urlSet of byPathLowerNoSlash.values()) {
    if (urlSet.size < 2) continue;
    const urlsList = [...urlSet].sort();
    const paths = urlsList.map((u) => new URL(u).pathname);
    const pathsNoSlash = paths.map((p) => p.replace(/\/$/, ""));

    if (new Set(pathsNoSlash).size < new Set(paths).size) {
      trailingSlashInconsistencies.push({ pages: urlsList });
    }
    if (new Set(pathsNoSlash).size > 1) {
      caseInconsistencies.push({ pages: urlsList });
    }
  }

  return {
    trailingSlashInconsistencies: trailingSlashInconsistencies.slice(0, 15),
    caseInconsistencies: caseInconsistencies.slice(0, 15),
    paramBloatCount: paramBloatUrls.length,
    paramBloatExamples: paramBloatUrls.slice(0, 10),
    trackingParamCount: trackingParamUrls.length,
    trackingParamExamples: trackingParamUrls.slice(0, 10),
  };
}
