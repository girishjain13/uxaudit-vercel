import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { audits, findings, links, pages } from "@/lib/db/schema";

type Page = typeof pages.$inferSelect;

async function handler(req: NextRequest, { params }: { params: Promise<{ auditId: string }> }) {
  const { auditId } = await params;

  try {
    const audit = await db.query.audits.findFirst({ where: eq(audits.id, auditId) });
    if (!audit) return NextResponse.json({ error: "audit not found" }, { status: 404 });

    const allPages = await db.select().from(pages).where(eq(pages.auditId, auditId));
    const allLinks = await db.select().from(links).where(eq(links.auditId, auditId));

    const newFindings = [
      ...findBrokenLinks(allPages),
      ...findMissingH1(allPages),
      ...findOrphanPages(allPages, allLinks, audit.startUrl),
      ...findMissingMetadata(allPages),
      ...findDuplicateTitles(allPages),
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
