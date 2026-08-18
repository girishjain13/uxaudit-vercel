import { createHash } from "crypto";
import * as cheerio from "cheerio";
import type { Element } from "domhandler";

/**
 * Direct port of the reference's crawler.py _structural_fingerprint /
 * _normalize_node: hashes a normalized skeleton of the page's HTML
 * structure (tag + first few sorted class names, ignoring actual text)
 * into a short ID. Pages sharing an ID are very likely built from the
 * same template/layout, regardless of URL pattern or title.
 *
 * Two things make this robust rather than brittle (same as the source):
 * - Only the first 3 class names (sorted) count per element, so utility
 *   class frameworks generating slightly different class soup per
 *   element don't defeat matching.
 * - Consecutive sibling elements with an identical shape (5 vs 50
 *   product cards, blog list items) collapse into one representative,
 *   so template detection isn't thrown off by how much content happens
 *   to be on a given page.
 *
 * This is a heuristic, not a guarantee — genuinely different templates
 * using very similar generic markup could collide, and instances of the
 * same template with very different optional sections could split
 * apart. Good enough to spot real structural patterns/outliers, not a
 * substitute for actually looking at the pages.
 */
export function structuralFingerprint(html: string, maxDepth = 6): string {
  if (!html) return "";
  const $ = cheerio.load(html);
  const bodyEl = $("body").get(0) ?? $.root().get(0);
  if (!bodyEl) return "";
  const skeleton = normalizeNode($, bodyEl as Element, maxDepth, 0);
  return createHash("sha1").update(skeleton, "utf8").digest("hex").slice(0, 12);
}

const SKIP_TAGS = new Set(["script", "style", "noscript", "svg"]);

function normalizeNode($: cheerio.CheerioAPI, node: Element, maxDepth: number, depth: number): string {
  if (depth > maxDepth) return "";
  const parts: string[] = [];
  let prevSig: string | null = null;
  let runLength = 0;

  const flush = () => {
    if (prevSig !== null) {
      parts.push(runLength <= 1 ? prevSig : `${prevSig}*`);
    }
  };

  const children = $(node)
    .children()
    .toArray() as Element[];

  for (const child of children) {
    const tagName = child.tagName?.toLowerCase();
    if (!tagName || SKIP_TAGS.has(tagName)) continue;
    const classAttr = $(child).attr("class") ?? "";
    const classes = classAttr.split(/\s+/).filter(Boolean).sort().slice(0, 3);
    const childSkeleton = normalizeNode($, child, maxDepth, depth + 1);
    const sig = `${tagName}.${classes.join(".")}(${childSkeleton})`;
    if (sig === prevSig) {
      runLength++;
      continue;
    }
    flush();
    prevSig = sig;
    runLength = 1;
  }
  flush();
  return parts.join("|");
}

export type TemplateGroup = {
  fingerprint: string;
  pageCount: number;
  exampleUrl: string;
  exampleTitle: string;
  sampleUrls: string[];
};

export type TemplateAnalysis = {
  uniqueTemplateCount: number;
  templates: TemplateGroup[];
  templatesWithReuse: number;
  oneOffCount: number;
  oneOffPages: { url: string; title: string }[];
  pagesAnalyzed: number;
};

/**
 * Groups already-fingerprinted pages into templates. Answers two things
 * a URL-pattern grouping can't: how many genuinely distinct layouts a
 * site actually uses (5000 pages but 6 templates is far cheaper to
 * redesign than 5000 pages and 40 templates), and which specific pages
 * are one-off outliers built from a layout nothing else on the site
 * uses — often either a legitimately special page, or drift from the
 * design system worth a second look.
 */
export function runTemplateAnalysis(
  pages: { url: string; title: string | null; statusCode: number | null; templateFingerprint: string | null }[],
): TemplateAnalysis {
  const realPages = pages.filter((p) => p.statusCode !== null && p.statusCode < 400 && p.templateFingerprint);

  const groups = new Map<string, typeof realPages>();
  for (const p of realPages) {
    const key = p.templateFingerprint!;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(p);
  }

  const templates: TemplateGroup[] = [...groups.entries()]
    .map(([fingerprint, recs]) => {
      const sorted = [...recs].sort((a, b) => a.url.localeCompare(b.url));
      return {
        fingerprint,
        pageCount: recs.length,
        exampleUrl: sorted[0].url,
        exampleTitle: sorted[0].title || "(untitled)",
        sampleUrls: sorted.slice(0, 5).map((r) => r.url),
      };
    })
    .sort((a, b) => b.pageCount - a.pageCount);

  const oneOffPages = templates
    .filter((t) => t.pageCount === 1)
    .map((t) => ({ url: t.exampleUrl, title: t.exampleTitle }));

  return {
    uniqueTemplateCount: templates.length,
    templates: templates.slice(0, 25),
    templatesWithReuse: templates.filter((t) => t.pageCount >= 2).length,
    oneOffCount: oneOffPages.length,
    oneOffPages: oneOffPages.slice(0, 25),
    pagesAnalyzed: realPages.length,
  };
}
