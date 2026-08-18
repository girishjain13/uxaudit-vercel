import * as cheerio from "cheerio";

/**
 * Port of the reference's crawler.py _extract_components +
 * analyzers/components.py. Deliberately looser than lib/templates.ts's
 * structural fingerprint: a "component" is identified by its own
 * tag+class only, not by hashing everything beneath it — the goal here
 * is "what kind of reusable widget is this" rather than "is this
 * pixel-identical to another instance." A signature only counts once
 * per page (10 product cards on one page = one occurrence of the
 * "card" component for that page, not ten) — repetition is only
 * meaningful when it's across pages.
 */

const COMPONENT_TAGS = ["div", "section", "article", "nav", "header", "footer", "aside", "form", "ul", "table", "dialog", "figure", "button"];
const BARE_TAG_OK = new Set(["nav", "form", "table", "dialog", "button", "header", "footer"]);
const STYLE_SENSITIVE_TAGS = new Set(["button", "nav", "form", "table"]);
const INCONSISTENCY_THRESHOLD = 3;

/** Extracts this page's set of component signatures — used per page, then merged across the crawl. */
export function extractComponentSignatures(html: string): string[] {
  const $ = cheerio.load(html);
  const pageTextLen = Math.max($("body").text().length, 1);
  const seenOnThisPage = new Set<string>();

  for (const tag of COMPONENT_TAGS) {
    $(tag).each((_, el) => {
      const classAttr = $(el).attr("class") ?? "";
      const classes = classAttr.split(/\s+/).filter(Boolean).sort().slice(0, 2);
      if (!classes.length && !BARE_TAG_OK.has(tag)) return;

      const elTextLen = $(el).text().trim().length;
      if (elTextLen / pageTextLen > 0.6) return; // this is basically the whole page, not a component

      const sig = classes.length ? `${tag}.${classes.join(".")}` : tag;
      seenOnThisPage.add(sig);
    });
  }

  return [...seenOnThisPage];
}

export type ComponentInfo = {
  signature: string;
  tag: string;
  classes: string;
  pageCount: number;
  pageCoveragePct: number;
  exampleUrl: string;
};

export type StyleInconsistency = {
  tag: string;
  distinctStyleCount: number;
  signatures: string[];
  totalPagesCovered: number;
};

export type ComponentAnalysis = {
  uniqueComponentCount: number;
  components: ComponentInfo[];
  pagesAnalyzed: number;
  styleInconsistencies: StyleInconsistency[];
};

/** `componentHits` maps a signature to the set of page URLs it appeared on — build this by calling extractComponentSignatures per page first. */
export function runComponentAnalysis(componentHits: Map<string, Set<string>>, totalPages: number): ComponentAnalysis {
  const components: ComponentInfo[] = [];
  for (const [sig, urls] of componentHits) {
    if (!urls.size) continue;
    const [tag, ...classParts] = sig.split(".");
    components.push({
      signature: sig,
      tag,
      classes: classParts.join("."),
      pageCount: urls.size,
      pageCoveragePct: totalPages ? Math.round((urls.size / totalPages) * 1000) / 10 : 0,
      exampleUrl: [...urls].sort()[0],
    });
  }
  components.sort((a, b) => b.pageCount - a.pageCount);

  // A component used on only 1 page isn't really "reusable" — reserve
  // the label for things that actually repeat across pages.
  const reusable = components.filter((c) => c.pageCount >= 2);

  const byTag = new Map<string, ComponentInfo[]>();
  for (const c of reusable) {
    if (STYLE_SENSITIVE_TAGS.has(c.tag) && c.classes) {
      if (!byTag.has(c.tag)) byTag.set(c.tag, []);
      byTag.get(c.tag)!.push(c);
    }
  }

  const styleInconsistencies: StyleInconsistency[] = [];
  for (const [tag, variants] of byTag) {
    if (variants.length < INCONSISTENCY_THRESHOLD) continue;
    const pagesCovered = new Set<string>();
    for (const v of variants) {
      for (const url of componentHits.get(v.signature) ?? []) pagesCovered.add(url);
    }
    styleInconsistencies.push({
      tag,
      distinctStyleCount: variants.length,
      signatures: variants.map((v) => v.signature),
      totalPagesCovered: pagesCovered.size,
    });
  }
  styleInconsistencies.sort((a, b) => b.distinctStyleCount - a.distinctStyleCount);

  return {
    uniqueComponentCount: reusable.length,
    components: reusable.slice(0, 40),
    pagesAnalyzed: totalPages,
    styleInconsistencies,
  };
}
