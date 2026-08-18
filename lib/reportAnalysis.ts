import * as cheerio from "cheerio";

/**
 * These run at export time, re-parsing the renderedDomHtml already stored
 * per page during the crawl — deliberately kept out of the Browserless
 * in-browser script (lib/browserless.ts). That script has been the most
 * error-prone part of this build so far; pushing the deeper structural
 * analysis (images/alt, schema.org, script domains, text/keyword
 * extraction) into plain server-side TypeScript with cheerio keeps it
 * testable and avoids adding more surface area to debug inside a remote
 * headless-browser function call.
 */

const BLOCK_TAGS = "p|div|h[1-6]|li|br|tr|td|section|article|header|footer|nav|ul|ol";

/**
 * Flesch Reading Ease. Syllable counting uses the standard vowel-group
 * heuristic (no dictionary) — accurate for the vast majority of English
 * words, occasionally off for irregular ones (e.g. silent-e edge cases).
 * Good enough for a directional readability signal, not a precise
 * linguistic measurement.
 */
export function fleschReadingEase(text: string): number | null {
  const words = text.match(/[a-zA-Z']+/g) ?? [];
  if (words.length < 20) return null; // too little text for a meaningful score

  const sentences = text.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  const sentenceCount = Math.max(sentences.length, 1);

  let syllableCount = 0;
  for (const word of words) {
    syllableCount += countSyllables(word);
  }

  const score =
    206.835 - 1.015 * (words.length / sentenceCount) - 84.6 * (syllableCount / words.length);
  return Math.round(score * 10) / 10;
}

function countSyllables(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return 0;
  const groups = w.match(/[aeiouy]+/g);
  let count = groups ? groups.length : 1;
  if (w.endsWith("e") && count > 1) count--;
  return Math.max(count, 1);
}

/**
 * Near-duplicate detection via shingling + Jaccard similarity — a real
 * (if simple) alternative to the exact-hash matching used elsewhere,
 * catching pages that are mostly the same with minor edits, not just
 * byte-identical ones. Deliberately capped: this is O(n²) page-pair
 * comparisons, so it's skipped above maxPages to keep an analysis run
 * bounded on very large audits — a smarter approach (e.g. MinHash/LSH)
 * would remove that cap, but isn't built here.
 */
export function findNearDuplicateClusters(
  pages: { url: string; text: string }[],
  { threshold = 0.75, shingleSize = 8, maxPages = 300 } = {},
): { pages: string[] }[] {
  if (pages.length > maxPages || pages.length < 2) return [];

  const shingleSets = pages.map((p) => ({ url: p.url, shingles: shingles(p.text, shingleSize) }));

  const parent = new Map<string, string>();
  const find = (x: string): string => {
    if (!parent.has(x)) parent.set(x, x);
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)!));
    return parent.get(x)!;
  };
  const union = (a: string, b: string) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (let i = 0; i < shingleSets.length; i++) {
    for (let j = i + 1; j < shingleSets.length; j++) {
      const a = shingleSets[i];
      const b = shingleSets[j];
      if (a.shingles.size === 0 || b.shingles.size === 0) continue;
      if (jaccardSimilarity(a.shingles, b.shingles) >= threshold) {
        union(a.url, b.url);
      }
    }
  }

  const clusters = new Map<string, Set<string>>();
  for (const { url } of shingleSets) {
    const root = find(url);
    if (!clusters.has(root)) clusters.set(root, new Set());
    clusters.get(root)!.add(url);
  }

  return [...clusters.values()].filter((c) => c.size > 1).map((c) => ({ pages: [...c] }));
}

function shingles(text: string, k: number): Set<string> {
  const words = text.toLowerCase().match(WORD_PATTERN) ?? [];
  const set = new Set<string>();
  for (let i = 0; i <= words.length - k; i++) {
    set.add(words.slice(i, i + k).join(" "));
  }
  return set;
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

export function extractVisibleText(html: string): string {
  // cheerio's .text() concatenates all descendant text nodes with no
  // whitespace inserted between sibling block elements — "<h1>Welcome</h1>
  // <p>Credit card</p>" would otherwise become "WelcomeCredit card",
  // silently merging word boundaries and corrupting keyword/word-count
  // extraction. Inserting literal space characters around block tags in
  // the raw markup, before cheerio parses it, fixes this at the source.
  const spaced = html
    .replace(new RegExp(`<(${BLOCK_TAGS})([ >])`, "gi"), " <$1$2")
    .replace(new RegExp(`</(${BLOCK_TAGS})>`, "gi"), "</$1> ");
  const $ = cheerio.load(spaced);
  $("script, style, noscript").remove();
  return $("body").text().replace(/\s+/g, " ").trim();
}

export function countImagesAndMissingAlt(html: string): { total: number; missing: number } {
  const $ = cheerio.load(html);
  let total = 0;
  let missing = 0;
  $("img").each((_, el) => {
    total++;
    const alt = $(el).attr("alt");
    if (!alt || !alt.trim()) missing++;
  });
  return { total, missing };
}

export function hasSchemaOrg(html: string): boolean {
  const $ = cheerio.load(html);
  return $('script[type="application/ld+json"]').length > 0 || $("[itemscope]").length > 0;
}

export function extractScripts(html: string, rootHost: string): { total: number; externalDomains: string[] } {
  const $ = cheerio.load(html);
  let total = 0;
  const externalDomains: string[] = [];
  $("script").each((_, el) => {
    total++;
    const src = $(el).attr("src");
    if (!src) return;
    try {
      const host = new URL(src, `https://${rootHost}`).host;
      if (host && host !== rootHost) externalDomains.push(host);
    } catch {
      /* skip unparseable script src */
    }
  });
  return { total, externalDomains };
}

/**
 * A simple, fast, deterministic hash — enough to catch exact-duplicate
 * page content (two URLs rendering byte-identical text). This is NOT
 * near-duplicate/similarity detection (the original spec's "cosine
 * similarity on extracted body text" requirement) — that's a
 * meaningfully bigger feature, flagged here rather than silently
 * pretending this covers it.
 */
export function textHash(text: string): string {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash << 5) - hash + text.charCodeAt(i);
    hash |= 0;
  }
  return String(hash);
}

export function pathDepth(url: string): number {
  try {
    return new URL(url).pathname.split("/").filter(Boolean).length;
  } catch {
    return 0;
  }
}

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "of", "with", "by",
  "is", "are", "was", "were", "be", "been", "this", "that", "these", "those", "it", "its",
  "as", "from", "your", "you", "we", "our", "us", "will", "can", "if", "not", "all", "more",
  "about", "into", "than", "then", "which", "their", "they", "he", "she", "his", "her",
  "have", "has", "had", "do", "does", "did", "up", "out", "so", "no", "yes", "how", "what",
  "when", "where", "who", "why", "here", "there", "also", "may", "any", "each", "other",
]);

const WORD_PATTERN = /[a-z][a-z'-]{2,}/g;

export function topKeywords(pages: { url: string; text: string }[], limit = 20) {
  const totalOccurrences = new Map<string, number>();
  const pagesContaining = new Map<string, Set<string>>();

  for (const { url, text } of pages) {
    const words = text.toLowerCase().match(WORD_PATTERN) ?? [];
    for (const w of words) {
      if (STOPWORDS.has(w)) continue;
      totalOccurrences.set(w, (totalOccurrences.get(w) ?? 0) + 1);
      if (!pagesContaining.has(w)) pagesContaining.set(w, new Set());
      pagesContaining.get(w)!.add(url);
    }
  }

  const totalPages = new Set(pages.map((p) => p.url)).size || 1;
  return [...totalOccurrences.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([keyword, occurrences]) => ({
      keyword,
      occurrences,
      pagesFoundOn: pagesContaining.get(keyword)?.size ?? 0,
      pctOfPages: Math.round(((pagesContaining.get(keyword)?.size ?? 0) / totalPages) * 1000) / 1000,
    }));
}

export function topPhrases(pages: { text: string }[], limit = 20) {
  const counts = new Map<string, number>();
  for (const { text } of pages) {
    const words = (text.toLowerCase().match(WORD_PATTERN) ?? []).filter((w) => !STOPWORDS.has(w));
    for (let i = 0; i < words.length - 1; i++) {
      const phrase = `${words[i]} ${words[i + 1]}`;
      counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([phrase, occurrences]) => ({ phrase, occurrences }));
}

/**
 * Deliberately small and honest: real integration fingerprinting (the
 * spec's "detect analytics tags, tag managers, chat widgets, A/B testing
 * tools") needs a much larger, maintained signature database. This
 * covers common cases; anything else correctly falls into "unrecognized"
 * rather than being silently misclassified.
 */
const KNOWN_INTEGRATIONS: { match: (host: string) => boolean; name: string; category: string }[] = [
  { match: (h) => h.includes("google-analytics.com") || h.includes("googletagmanager.com"), name: "Google Analytics / Tag Manager", category: "Analytics" },
  { match: (h) => h.includes("maps.googleapis.com") || h.includes("maps.google.com"), name: "Google Maps", category: "Maps" },
  { match: (h) => h.includes("facebook.net") || h.includes("connect.facebook"), name: "Meta Pixel", category: "Marketing" },
  { match: (h) => h.includes("hotjar.com"), name: "Hotjar", category: "Analytics" },
  { match: (h) => h.includes("doubleclick.net"), name: "Google Ads", category: "Marketing" },
  { match: (h) => h.includes("tiqcdn.com") || h.includes("tealium"), name: "Tealium", category: "Tag Manager" },
  { match: (h) => h.includes("awswaf.com"), name: "AWS WAF", category: "Security" },
  { match: (h) => h.includes("intercom.io") || h.includes("intercomcdn"), name: "Intercom", category: "Chat / Support" },
  { match: (h) => h.includes("hs-scripts.com") || h.includes("hubspot"), name: "HubSpot", category: "Marketing" },
  { match: (h) => h.includes("cloudflare.com") || h.includes("cloudflareinsights"), name: "Cloudflare", category: "Infrastructure" },
];

export function classifyIntegrations(perPage: { url: string; domains: string[] }[]) {
  const recognizedPages = new Map<string, Set<string>>();
  const recognizedCategory = new Map<string, string>();
  const unrecognizedRefs = new Map<string, number>();

  for (const { url, domains } of perPage) {
    for (const domain of domains) {
      const match = KNOWN_INTEGRATIONS.find((k) => k.match(domain));
      if (match) {
        if (!recognizedPages.has(match.name)) recognizedPages.set(match.name, new Set());
        recognizedPages.get(match.name)!.add(url);
        recognizedCategory.set(match.name, match.category);
      } else {
        unrecognizedRefs.set(domain, (unrecognizedRefs.get(domain) ?? 0) + 1);
      }
    }
  }

  const totalPages = new Set(perPage.map((p) => p.url)).size || 1;
  const recognized = [...recognizedPages.entries()]
    .map(([name, pages]) => ({
      name,
      category: recognizedCategory.get(name) ?? "Other",
      pagesFoundOn: pages.size,
      pctOfPages: Math.round((pages.size / totalPages) * 1000) / 1000,
    }))
    .sort((a, b) => b.pagesFoundOn - a.pagesFoundOn);

  const unrecognized = [...unrecognizedRefs.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([domain, references]) => ({ domain, references }));

  return { recognized, unrecognized };
}
