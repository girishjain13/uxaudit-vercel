import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { audits, findings, links, pages } from "@/lib/db/schema";
import { extractVisibleText, findNearDuplicateClusters, fleschReadingEase } from "@/lib/reportAnalysis";
import { runTemplateAnalysis, structuralFingerprint } from "@/lib/templates";
import {
  detectCms,
  detectJsFrameworks,
  hasMixedContent,
  hasPiiFormWithoutPrivacyLink,
  looksLikeExposedStaging,
} from "@/lib/techFingerprint";

type Page = typeof pages.$inferSelect;

async function handler(req: NextRequest, { params }: { params: Promise<{ auditId: string }> }) {
  const { auditId } = await params;

  try {
    const audit = await db.query.audits.findFirst({ where: eq(audits.id, auditId) });
    if (!audit) return NextResponse.json({ error: "audit not found" }, { status: 404 });

    const allPages = await db.select().from(pages).where(eq(pages.auditId, auditId));
    const allLinks = await db.select().from(links).where(eq(links.auditId, auditId));

    // Compute + persist each page's structural fingerprint before running
    // the rollup — pages.templateFingerprint existed in the schema from
    // the start but was never populated until now.
    for (const p of allPages) {
      if (!p.renderedDomHtml) continue;
      const fingerprint = structuralFingerprint(p.renderedDomHtml);
      if (fingerprint) {
        await db.update(pages).set({ templateFingerprint: fingerprint }).where(eq(pages.id, p.id));
        p.templateFingerprint = fingerprint; // keep the in-memory copy in sync for the findings below
      }
    }

    const newFindings = [
      ...findBrokenLinks(allPages),
      ...findMissingH1(allPages),
      ...findOrphanPages(allPages, allLinks, audit.startUrl),
      ...findMissingMetadata(allPages),
      ...findDuplicateTitles(allPages),
      ...findAccessibilityViolations(allPages),
      ...findTechStack(allPages),
      ...findRiskFlags(allPages),
      ...findNearDuplicateContent(allPages),
      ...findLowReadability(allPages),
      ...findTemplateRollup(allPages),
      buildScaleSummary(allPages),
    ];

    if (newFindings.length) {
      await db.insert(findings).values(newFindings.map((f) => ({ ...f, auditId })));
    }

    await db
      .update(audits)
      .set({ status: "done", finishedAt: new Date() })
      .where(eq(audits.id, auditId));

    return NextResponse.json({ ok: true, auditId, pageCount: allPages.length, findingCount: newFindings.length });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[analyze] audit=${auditId}:`, err);
    await db
      .update(audits)
      .set({ status: "failed", errorMessage: message, finishedAt: new Date() })
      .where(eq(audits.id, auditId));
    return NextResponse.json({ ok: false, error: message });
  }
}

type NewFinding = typeof findings.$inferInsert extends infer T ? Omit<T, "auditId" | "id" | "detectedAt"> : never;

// --- UX Lead ---

function findBrokenLinks(allPages: Page[]): NewFinding[] {
  const broken = allPages.filter((p) => p.statusCode !== null && p.statusCode >= 400);
  if (!broken.length) return [];
  return [
    {
      findingType: "broken_page",
      title: `${broken.length} page${broken.length === 1 ? "" : "s"} returning an error status`,
      description:
        "These pages returned an HTTP 4xx/5xx status during the crawl, meaning they're broken links or " +
        "missing content — a direct hit to user trust and SEO.",
      severity: broken.length > 5 ? "high" : "medium",
      effortBucket: "config",
      personas: ["ux", "business"],
      affectedPageCount: broken.length,
      affectedUrlsSample: broken.slice(0, 10).map((p) => p.url),
      affectedTemplate: null,
      detectionMethod: "HTTP status code >= 400 recorded during crawl",
    },
  ];
}

function findMissingH1(allPages: Page[]): NewFinding[] {
  const missing = allPages.filter((p) => !p.error && !p.h1Text);
  if (!missing.length) return [];
  return [
    {
      findingType: "missing_h1",
      title: `${missing.length} page${missing.length === 1 ? "" : "s"} missing an H1 heading`,
      description:
        "No <h1> element was found on these pages. This affects both accessibility (screen readers rely on " +
        "heading structure) and SEO (search engines use H1 as a primary relevance signal.",
      severity: "medium",
      effortBucket: "config",
      personas: ["ux", "content"],
      affectedPageCount: missing.length,
      affectedUrlsSample: missing.slice(0, 10).map((p) => p.url),
      affectedTemplate: null,
      detectionMethod: "querySelector('h1') returned null during rendered-DOM extraction",
    },
  ];
}

function findOrphanPages(allPages: Page[], allLinks: (typeof links.$inferSelect)[], startUrl: string): NewFinding[] {
  const inboundCounts = new Map<string, number>();
  for (const link of allLinks) {
    if (!link.isInternal) continue;
    inboundCounts.set(link.targetUrl, (inboundCounts.get(link.targetUrl) ?? 0) + 1);
  }
  // The start page is excluded — it has no inbound link by definition
  // (nothing points to the homepage from within the crawl), which isn't
  // the same problem as a genuinely orphaned interior page.
  const orphans = allPages.filter((p) => !p.error && p.url !== startUrl && !inboundCounts.get(p.url));
  if (!orphans.length) return [];
  return [
    {
      findingType: "orphan_page",
      title: `${orphans.length} orphan page${orphans.length === 1 ? "" : "s"} with no inbound internal links`,
      description:
        "These pages were reachable during the crawl but have no other crawled page linking to them — " +
        "likely unreachable through normal site navigation, which is a content-silo and IA risk.",
      severity: "medium",
      effortBucket: "config",
      personas: ["ux", "content"],
      affectedPageCount: orphans.length,
      affectedUrlsSample: orphans.slice(0, 10).map((p) => p.url),
      affectedTemplate: null,
      detectionMethod: "Zero matching rows in the links table with this URL as an internal target",
    },
  ];
}

// --- Content Strategist ---

function findMissingMetadata(allPages: Page[]): NewFinding[] {
  const out: NewFinding[] = [];
  const missingTitle = allPages.filter((p) => !p.error && !p.title);
  const missingMeta = allPages.filter((p) => !p.error && !p.metaDescription);

  if (missingTitle.length) {
    out.push({
      findingType: "missing_title",
      title: `${missingTitle.length} page${missingTitle.length === 1 ? "" : "s"} missing a <title> tag`,
      description: "Pages without a title tag hurt both SEO ranking and browser-tab/bookmark usability.",
      severity: "high",
      effortBucket: "config",
      personas: ["content", "business"],
      affectedPageCount: missingTitle.length,
      affectedUrlsSample: missingTitle.slice(0, 10).map((p) => p.url),
      affectedTemplate: null,
      detectionMethod: "document.title was empty during rendered-DOM extraction",
    });
  }

  if (missingMeta.length) {
    out.push({
      findingType: "missing_meta_description",
      title: `${missingMeta.length} page${missingMeta.length === 1 ? "" : "s"} missing a meta description`,
      description:
        "No <meta name=\"description\"> tag was found. Search engines fall back to auto-generated snippets, " +
        "which is a missed opportunity for click-through and consistent brand messaging.",
      severity: "low",
      effortBucket: "config",
      personas: ["content"],
      affectedPageCount: missingMeta.length,
      affectedUrlsSample: missingMeta.slice(0, 10).map((p) => p.url),
      affectedTemplate: null,
      detectionMethod: "querySelector('meta[name=\"description\"]') returned null",
    });
  }

  return out;
}

function findDuplicateTitles(allPages: Page[]): NewFinding[] {
  const byTitle = new Map<string, Page[]>();
  for (const p of allPages) {
    if (!p.title) continue;
    const group = byTitle.get(p.title) ?? [];
    group.push(p);
    byTitle.set(p.title, group);
  }
  const duplicateGroups = [...byTitle.values()].filter((g) => g.length > 1);
  if (!duplicateGroups.length) return [];
  const affected = duplicateGroups.flat();
  return [
    {
      findingType: "duplicate_title",
      title: `${duplicateGroups.length} title tag${duplicateGroups.length === 1 ? "" : "s"} reused across ${affected.length} pages`,
      description:
        "Multiple pages share the exact same <title> text. Search engines and users both rely on titles to " +
        "distinguish pages — duplication here usually signals a templating issue or thin/boilerplate content.",
      severity: "medium",
      effortBucket: "config",
      personas: ["content", "business"],
      affectedPageCount: affected.length,
      affectedUrlsSample: affected.slice(0, 10).map((p) => p.url),
      affectedTemplate: null,
      detectionMethod: "Exact string match on the title field across crawled pages",
    },
  ];
}

// --- UX Lead / Business Analyst: template-level rollup ---
// This is the spec's core architecture requirement ("findings must be
// aggregated at the template/pattern level, not just page level") made
// visible as its own finding, not just an implementation detail of how
// other findings are counted.

function findTemplateRollup(allPages: Page[]): NewFinding[] {
  const analysis = runTemplateAnalysis(
    allPages.map((p) => ({
      url: p.url,
      title: p.title,
      statusCode: p.statusCode,
      templateFingerprint: p.templateFingerprint,
    })),
  );

  if (analysis.pagesAnalyzed === 0) return [];

  const out: NewFinding[] = [
    {
      findingType: "template_rollup",
      title: `${analysis.uniqueTemplateCount} distinct page template(s) detected across ${analysis.pagesAnalyzed} page(s)`,
      description:
        `${analysis.templatesWithReuse} template(s) are reused across 2+ pages; the largest covers ` +
        `${analysis.templates[0]?.pageCount ?? 0} page(s) (example: ${analysis.templates[0]?.exampleUrl ?? "n/a"}). ` +
        "Fewer distinct templates generally means a more consistent, cheaper-to-maintain site.",
      severity: "low",
      effortBucket: "ootb",
      personas: ["ux", "business"],
      affectedPageCount: analysis.pagesAnalyzed,
      affectedUrlsSample: analysis.templates[0]?.sampleUrls ?? [],
      affectedTemplate: analysis.templates[0]?.fingerprint ?? null,
      detectionMethod: "DOM structural-skeleton hashing (tag + top-level classes, siblings collapsed) via lib/templates.ts",
    },
  ];

  if (analysis.oneOffCount > 0) {
    out.push({
      findingType: "one_off_template",
      title: `${analysis.oneOffCount} page(s) use a layout no other page on the site shares`,
      description:
        "These pages are structural outliers — either a legitimately special page (a campaign landing page, a " +
        "one-time announcement) or drift from the design system worth a second look.",
      severity: "low",
      effortBucket: "custom_dev",
      personas: ["ux"],
      affectedPageCount: analysis.oneOffCount,
      affectedUrlsSample: analysis.oneOffPages.slice(0, 10).map((p) => p.url),
      affectedTemplate: null,
      detectionMethod: "Structural fingerprint with exactly 1 matching page across the crawl",
    });
  }

  return out;
}

// --- UX Lead: Accessibility (axe-core, aggregated by rule across pages) ---

const AXE_IMPACT_TO_SEVERITY: Record<string, NewFinding["severity"]> = {
  critical: "critical",
  serious: "high",
  moderate: "medium",
  minor: "low",
};

function findAccessibilityViolations(allPages: Page[]): NewFinding[] {
  // Aggregate by axe rule id across all pages — the spec's rollup
  // requirement ("1 finding affecting 500 pages, not 500 rows") applies
  // directly here: the same rule (e.g. "image-alt") firing on 40 pages
  // becomes one finding, not 40.
  const byRuleId = new Map<string, { impact: string; description: string; pages: Set<string> }>();
  for (const p of allPages) {
    for (const v of p.accessibilityViolations ?? []) {
      if (!byRuleId.has(v.id)) {
        byRuleId.set(v.id, { impact: v.impact, description: v.description, pages: new Set() });
      }
      byRuleId.get(v.id)!.pages.add(p.url);
    }
  }

  return [...byRuleId.entries()].map(([ruleId, data]) => ({
    findingType: "accessibility_violation",
    title: `WCAG issue: ${data.description}`,
    description: `axe-core rule "${ruleId}" (${data.impact} impact) triggered on ${data.pages.size} page(s).`,
    severity: AXE_IMPACT_TO_SEVERITY[data.impact] ?? "medium",
    effortBucket: "config",
    personas: ["ux"],
    affectedPageCount: data.pages.size,
    affectedUrlsSample: [...data.pages].slice(0, 10),
    affectedTemplate: null,
    detectionMethod: `axe-core 4.x automated WCAG 2.1 AA scan, rule "${ruleId}"`,
  }));
}

// --- Business Analyst: Tech stack fingerprinting (informational, not a "problem") ---

function findTechStack(allPages: Page[]): NewFinding[] {
  const cmsPages = new Map<string, Set<string>>();
  const frameworkPages = new Map<string, Set<string>>();

  for (const p of allPages) {
    const html = p.renderedDomHtml || "";
    if (!html) continue;
    for (const cms of detectCms(html)) {
      if (!cmsPages.has(cms)) cmsPages.set(cms, new Set());
      cmsPages.get(cms)!.add(p.url);
    }
    for (const fw of detectJsFrameworks(html)) {
      if (!frameworkPages.has(fw)) frameworkPages.set(fw, new Set());
      frameworkPages.get(fw)!.add(p.url);
    }
  }

  const out: NewFinding[] = [];
  for (const [name, pageSet] of cmsPages) {
    out.push({
      findingType: "cms_detected",
      title: `Detected platform: ${name}`,
      description: `Signatures matching ${name} were found on ${pageSet.size} page(s).`,
      severity: "low",
      effortBucket: "ootb",
      personas: ["business"],
      affectedPageCount: pageSet.size,
      affectedUrlsSample: [...pageSet].slice(0, 10),
      affectedTemplate: null,
      detectionMethod: "HTML path/meta-tag signature match",
    });
  }
  for (const [name, pageSet] of frameworkPages) {
    out.push({
      findingType: "js_framework_detected",
      title: `Detected JS framework: ${name}`,
      description: `Signatures matching ${name} were found on ${pageSet.size} page(s) — relevant for migration/replatforming effort scoping.`,
      severity: "low",
      effortBucket: "ootb",
      personas: ["business"],
      affectedPageCount: pageSet.size,
      affectedUrlsSample: [...pageSet].slice(0, 10),
      affectedTemplate: null,
      detectionMethod: "DOM attribute/global-variable signature match",
    });
  }
  return out;
}

// --- Business Analyst: Risk flags ---

function findRiskFlags(allPages: Page[]): NewFinding[] {
  const out: NewFinding[] = [];

  const mixedContentPages = allPages.filter((p) => p.renderedDomHtml && hasMixedContent(p.renderedDomHtml, p.url));
  if (mixedContentPages.length) {
    out.push({
      findingType: "mixed_content",
      title: `${mixedContentPages.length} page(s) load insecure (HTTP) resources on an HTTPS page`,
      description:
        "Mixed content causes browser warnings and can be silently blocked, breaking images/scripts/styles for users.",
      severity: "high",
      effortBucket: "config",
      personas: ["business", "ux"],
      affectedPageCount: mixedContentPages.length,
      affectedUrlsSample: mixedContentPages.slice(0, 10).map((p) => p.url),
      affectedTemplate: null,
      detectionMethod: "HTTP-scheme src/href found on an HTTPS page",
    });
  }

  const stagingPages = allPages.filter((p) => looksLikeExposedStaging(p.url));
  if (stagingPages.length) {
    out.push({
      findingType: "exposed_staging",
      title: `${stagingPages.length} page(s) appear to be on a staging/dev subdomain`,
      description:
        "URLs matching common staging/dev/test naming patterns were reachable during this crawl — worth confirming these aren't unintentionally public.",
      severity: "medium",
      effortBucket: "config",
      personas: ["business"],
      affectedPageCount: stagingPages.length,
      affectedUrlsSample: stagingPages.slice(0, 10).map((p) => p.url),
      affectedTemplate: null,
      detectionMethod: "Hostname pattern match (staging/dev/test/uat/preprod/qa)",
    });
  }

  const piiPages = allPages.filter((p) => p.renderedDomHtml && hasPiiFormWithoutPrivacyLink(p.renderedDomHtml));
  if (piiPages.length) {
    out.push({
      findingType: "pii_without_privacy_link",
      title: `${piiPages.length} page(s) have a form collecting personal data with no visible privacy-policy link`,
      description:
        "Heuristic signal, not a compliance determination — worth a manual check on these forms and their surrounding disclosures.",
      severity: "medium",
      effortBucket: "config",
      personas: ["business"],
      affectedPageCount: piiPages.length,
      affectedUrlsSample: piiPages.slice(0, 10).map((p) => p.url),
      affectedTemplate: null,
      detectionMethod: "Form field type/name heuristic + absence of a nearby 'privacy' link",
    });
  }

  return out;
}

// --- Content Strategist: near-duplicate content (shingling + Jaccard, not just exact hash) ---

function findNearDuplicateContent(allPages: Page[]): NewFinding[] {
  const withText = allPages
    .filter((p) => p.renderedDomHtml)
    .map((p) => ({ url: p.url, text: extractVisibleText(p.renderedDomHtml!) }));

  const clusters = findNearDuplicateClusters(withText);
  if (!clusters.length) return [];

  const totalAffected = clusters.reduce((sum, c) => sum + c.pages.length, 0);
  return [
    {
      findingType: "near_duplicate_content",
      title: `${clusters.length} cluster(s) of near-duplicate pages found (${totalAffected} pages total)`,
      description:
        "These pages are textually very similar (≥75% shingle overlap) without being byte-identical — usually a sign of thin templated content or copy-pasted pages.",
      severity: "medium",
      effortBucket: "config",
      personas: ["content"],
      affectedPageCount: totalAffected,
      affectedUrlsSample: clusters[0].pages.slice(0, 10),
      affectedTemplate: null,
      detectionMethod: "8-word shingling + Jaccard similarity across extracted page text, threshold 0.75",
    },
  ];
}

// --- Content Strategist: readability ---

function findLowReadability(allPages: Page[]): NewFinding[] {
  const scored = allPages
    .filter((p) => p.renderedDomHtml)
    .map((p) => ({ url: p.url, score: fleschReadingEase(extractVisibleText(p.renderedDomHtml!)) }))
    .filter((p): p is { url: string; score: number } => p.score !== null);

  const difficult = scored.filter((p) => p.score < 30); // Flesch < 30 ≈ "very difficult"
  if (!difficult.length) return [];

  return [
    {
      findingType: "low_readability",
      title: `${difficult.length} page(s) score as "very difficult to read"`,
      description:
        `Flesch Reading Ease below 30 (college-graduate level or harder) on ${difficult.length} page(s) — ` +
        "worth reviewing for plain-language opportunities, especially on customer-facing content.",
      severity: "low",
      effortBucket: "custom_dev",
      personas: ["content"],
      affectedPageCount: difficult.length,
      affectedUrlsSample: difficult.slice(0, 10).map((p) => p.url),
      affectedTemplate: null,
      detectionMethod: "Flesch Reading Ease formula computed on extracted visible text",
    },
  ];
}

// --- Business Analyst ---
// A real (if simple) scale summary rather than the full tech-fingerprinting/
// risk-flagging module described in the spec — that part is still unbuilt.
// This gives the Business Analyst persona at least one genuine finding
// instead of zero, while being honest that redirect mapping, SSL checks,
// mixed-content detection, and benchmark variance are still TODOs.
function buildScaleSummary(allPages: Page[]): NewFinding {
  const successfulPages = allPages.filter((p) => !p.error);
  const errorPages = allPages.filter((p) => p.error);
  const avgResponseTime =
    successfulPages.length > 0
      ? Math.round(
          successfulPages.reduce((sum, p) => sum + (p.responseTimeMs ?? 0), 0) / successfulPages.length,
        )
      : 0;
  const clientRenderedCount = successfulPages.filter((p) => p.isClientRendered).length;

  return {
    findingType: "scale_summary",
    title: `Crawl covered ${allPages.length} page${allPages.length === 1 ? "" : "s"}`,
    description:
      `${successfulPages.length} rendered successfully, ${errorPages.length} failed or were blocked. ` +
      `Average response time: ${avgResponseTime}ms. ${clientRenderedCount} page(s) appear primarily ` +
      `client-rendered, relevant for scoping migration/re-platforming effort.`,
    severity: "low",
    effortBucket: "ootb",
    personas: ["business"],
    affectedPageCount: allPages.length,
    affectedUrlsSample: allPages.slice(0, 10).map((p) => p.url),
    affectedTemplate: null,
    detectionMethod: "Aggregated directly from crawl results — see the pages table for the full dataset",
  };
}

// See app/api/crawl/page/route.ts for why this wraps at request time
// rather than module scope.
export async function POST(req: NextRequest, ctx: { params: Promise<{ auditId: string }> }) {
  const verified = verifySignatureAppRouter((r: NextRequest) => handler(r, ctx));
  return verified(req);
}
