import * as cheerio from "cheerio";

/**
 * Two things this doc asks for that weren't checked before:
 * - OG/Twitter Card completeness (we only checked title/meta description)
 * - Schema.org *type-specific* detection (we only checked generic
 *   presence of any ld+json block, not which @type(s) it declares)
 */

export type MetaCompleteness = {
  hasOgTitle: boolean;
  hasOgDescription: boolean;
  hasOgImage: boolean;
  hasTwitterCard: boolean;
  ogComplete: boolean;
};

export function checkMetaCompleteness(html: string): MetaCompleteness {
  const $ = cheerio.load(html);
  const hasOgTitle = $('meta[property="og:title"]').length > 0;
  const hasOgDescription = $('meta[property="og:description"]').length > 0;
  const hasOgImage = $('meta[property="og:image"]').length > 0;
  const hasTwitterCard = $('meta[name="twitter:card"]').length > 0;
  return {
    hasOgTitle,
    hasOgDescription,
    hasOgImage,
    hasTwitterCard,
    ogComplete: hasOgTitle && hasOgDescription && hasOgImage,
  };
}

const SCHEMA_TYPES_OF_INTEREST = ["Organization", "BreadcrumbList", "Article", "Product", "WebPage", "FAQPage"];

/** Returns which of the common schema.org @types (if any) this page declares via JSON-LD. */
export function detectSchemaTypes(html: string): string[] {
  const $ = cheerio.load(html);
  const found = new Set<string>();
  $('script[type="application/ld+json"]').each((_, el) => {
    const raw = $(el).contents().text();
    try {
      const parsed = JSON.parse(raw);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const type = item?.["@type"];
        const types = Array.isArray(type) ? type : [type];
        for (const t of types) {
          if (typeof t === "string" && SCHEMA_TYPES_OF_INTEREST.includes(t)) found.add(t);
        }
      }
    } catch {
      /* malformed JSON-LD — skip rather than throw */
    }
  });
  return [...found];
}
