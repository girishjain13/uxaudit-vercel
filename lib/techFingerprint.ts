import * as cheerio from "cheerio";

/**
 * Honest scope note: this covers the common, detectable-from-HTML cases
 * for each category. It does NOT cover SSL certificate status/expiry
 * (needs a real TLS handshake, not HTML inspection — genuinely separate
 * infrastructure work) or CDN detection via response headers (we don't
 * currently capture response headers at all, only the HTML body).
 */

const CMS_SIGNATURES: { match: (html: string) => boolean; name: string }[] = [
  { match: (h) => /wp-content|wp-includes/i.test(h), name: "WordPress" },
  { match: (h) => /\/sites\/default\/files/i.test(h), name: "Drupal" },
  { match: (h) => /\/typo3(conf|temp)\//i.test(h), name: "TYPO3" },
  { match: (h) => /\/etc\.clientlibs\/|cq:template/i.test(h), name: "Adobe Experience Manager" },
  { match: (h) => /\/umbraco\//i.test(h), name: "Umbraco" },
  { match: (h) => /cdn\.shopify\.com|Shopify\.theme/i.test(h), name: "Shopify" },
  { match: (h) => /static\.wixstatic\.com/i.test(h), name: "Wix" },
  { match: (h) => /squarespace\.com\/universal/i.test(h), name: "Squarespace" },
  { match: (h) => /<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i.test(h), name: "generator-meta-tag" },
];

export function detectCms(html: string): string[] {
  const found = new Set<string>();
  for (const sig of CMS_SIGNATURES) {
    if (sig.match(html)) {
      if (sig.name === "generator-meta-tag") {
        const m = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']([^"']+)["']/i);
        if (m) found.add(m[1]);
      } else {
        found.add(sig.name);
      }
    }
  }
  return [...found];
}

const JS_FRAMEWORK_SIGNATURES: { match: (html: string) => boolean; name: string }[] = [
  { match: (h) => /data-reactroot|__next_data__/i.test(h), name: "React / Next.js" },
  { match: (h) => /ng-version=/i.test(h), name: "Angular" },
  { match: (h) => /data-v-[a-f0-9]{8}|__nuxt__/i.test(h), name: "Vue.js / Nuxt" },
  { match: (h) => /svelte-[a-z0-9]{6}/i.test(h), name: "Svelte" },
];

export function detectJsFrameworks(html: string): string[] {
  const found = new Set<string>();
  for (const sig of JS_FRAMEWORK_SIGNATURES) {
    if (sig.match(html)) found.add(sig.name);
  }
  return [...found];
}

export function hasMixedContent(html: string, pageUrl: string): boolean {
  if (!pageUrl.startsWith("https://")) return false;
  const $ = cheerio.load(html);
  let found = false;
  $("img[src], script[src], link[href], iframe[src]").each((_, el) => {
    const src = $(el).attr("src") || $(el).attr("href");
    if (src && src.startsWith("http://")) found = true;
  });
  return found;
}

export function looksLikeExposedStaging(url: string): boolean {
  try {
    const host = new URL(url).host.toLowerCase();
    return /(^|\.)(staging|stage|dev|test|uat|preprod|qa)(\.|-)/.test(host);
  } catch {
    return false;
  }
}

/**
 * Heuristic, not a legal/compliance determination: flags a form that
 * collects clearly personal fields (email, phone, government-ID-shaped
 * inputs) with no nearby link whose text or href mentions "privacy".
 * False positives/negatives are both possible — this is a discovery-phase
 * signal to investigate, not a definitive compliance finding.
 */
export function hasPiiFormWithoutPrivacyLink(html: string): boolean {
  const $ = cheerio.load(html);
  let hasPiiField = false;
  $("form input").each((_, el) => {
    const type = ($(el).attr("type") || "").toLowerCase();
    const name = ($(el).attr("name") || "").toLowerCase();
    if (["email", "tel", "password"].includes(type)) hasPiiField = true;
    if (/ssn|aadhaar|passport|pan\b|national.?id/.test(name)) hasPiiField = true;
  });
  if (!hasPiiField) return false;

  let hasPrivacyLink = false;
  $("a").each((_, el) => {
    const text = $(el).text().toLowerCase();
    const href = ($(el).attr("href") || "").toLowerCase();
    if (text.includes("privacy") || href.includes("privacy")) hasPrivacyLink = true;
  });
  return !hasPrivacyLink;
}
