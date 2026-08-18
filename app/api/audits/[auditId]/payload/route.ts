import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { audits, findings, links, pages } from "@/lib/db/schema";
import { buildScorecard } from "@/lib/scoring";
import { countImagesAndMissingAlt } from "@/lib/reportAnalysis";
import { detectSchemaTypes } from "@/lib/metaCompleteness";
import { detectForms } from "@/lib/formDetection";
import { quadrantOf } from "@/lib/quadrant";

/**
 * Matches the exact JSON payload structure specified in the
 * "Project Onboarding Website Discovery & Heuristic Engine" doc's
 * section 4 — built directly from data already computed elsewhere
 * (scoring.ts, the findings table), reshaped into this specific schema
 * rather than duplicating detection logic.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ auditId: string }> }) {
  const { auditId } = await params;

  const audit = await db.query.audits.findFirst({ where: eq(audits.id, auditId) });
  if (!audit) return NextResponse.json({ error: "audit not found" }, { status: 404 });

  const allPages = await db.select().from(pages).where(eq(pages.auditId, auditId));
  const allFindings = await db.select().from(findings).where(eq(findings.auditId, auditId));
  const allLinks = await db.select().from(links).where(eq(links.auditId, auditId));

  const findingByType = (type: string) => allFindings.find((f) => f.findingType === type);

  let totalImages = 0;
  let totalMissingAlt = 0;
  let schemaPagesWithType = 0;
  const formConversionPoints: { url: string; purpose: string; fieldCount: number }[] = [];

  for (const p of allPages) {
    if (!p.renderedDomHtml) continue;
    const { total, missing } = countImagesAndMissingAlt(p.renderedDomHtml);
    totalImages += total;
    totalMissingAlt += missing;

    if (detectSchemaTypes(p.renderedDomHtml).length > 0) schemaPagesWithType++;

    for (const form of detectForms(p.renderedDomHtml)) {
      if (form.likelyPurpose !== "other") {
        formConversionPoints.push({ url: p.url, purpose: form.likelyPurpose, fieldCount: form.fieldCount });
      }
    }
  }
  const imageAltCoveragePct = totalImages > 0 ? Math.round((1 - totalMissingAlt / totalImages) * 1000) / 10 : 100;
  const schemaCoveragePct = allPages.length > 0 ? Math.round((schemaPagesWithType / allPages.length) * 1000) / 10 : 0;

  const scorecard = buildScorecard({
    totalPages: allPages.length,
    orphanPageCount: findingByType("orphan_page")?.affectedPageCount ?? 0,
    pagesOverThreeClicks: allPages.filter((p) => p.depth > 3).length,
    thinContentCount: allPages.filter((p) => p.wordCount > 0 && p.wordCount < 150).length,
    duplicateContentPageCount:
      (findingByType("duplicate_title")?.affectedPageCount ?? 0) +
      (findingByType("near_duplicate_content")?.affectedPageCount ?? 0),
    missingH1Count: findingByType("missing_h1")?.affectedPageCount ?? 0,
    imageAltCoveragePct,
    pagesWithAccessibilityIssues: allPages.filter((p) => (p.accessibilityViolations ?? []).length > 0).length,
    missingTitleCount: findingByType("missing_title")?.affectedPageCount ?? 0,
    missingMetaDescriptionCount: findingByType("missing_meta_description")?.affectedPageCount ?? 0,
    canonicalMissingCount: allPages.filter((p) => !p.canonical).length,
  });

  const brokenRoutesCount = allPages.filter((p) => p.statusCode !== null && p.statusCode >= 400).length;

  const accessibilityBlockers: string[] = [];
  if ((findingByType("missing_h1")?.affectedPageCount ?? 0) > 0) accessibilityBlockers.push("Missing H1 heading");
  const missingAltFinding = allFindings.find((f) => f.findingType === "accessibility_violation" && f.title.toLowerCase().includes("alt"));
  if (missingAltFinding || totalMissingAlt > 0) accessibilityBlockers.push("Missing alt text");
  if (allFindings.some((f) => f.findingType === "missing_lang_attribute")) accessibilityBlockers.push("Missing lang tag");
  if (allFindings.some((f) => f.findingType === "accessibility_violation" && f.title.toLowerCase().includes("landmark"))) {
    accessibilityBlockers.push("No ARIA landmark regions");
  }

  const duplicateClusters = allFindings
    .filter((f) => f.findingType === "near_duplicate_content" || f.findingType === "duplicate_title")
    .map((f) => f.affectedUrlsSample);

  const prioritizedBacklogItems = [...allFindings]
    .filter((f) => f.findingType !== "scale_summary")
    .sort((a, b) => {
      const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      return (rank[a.severity] ?? 4) - (rank[b.severity] ?? 4);
    })
    .map((f) => ({
      title: f.title,
      impact: f.severity === "critical" || f.severity === "high" ? "High" : "Low",
      effort: f.effortBucket === "custom_dev" ? "High" : "Low",
      quadrant: quadrantOf(f),
      category: f.personas.join(", "),
    }));

  const payload = {
    project_metadata: {
      site_url: audit.startUrl,
      crawl_date: audit.finishedAt ? new Date(audit.finishedAt).toISOString() : new Date().toISOString(),
      pages_scanned: allPages.length,
      rendering_engine: "Headless-Chromium",
    },
    scores: {
      overall_ux_maturity: scorecard.uxMaturityScore,
      ia_health: scorecard.iaHealthScore,
      content_quality: scorecard.contentQualityScore,
      accessibility_wcag: scorecard.accessibilityScore,
      seo_findability: scorecard.seoScore,
    },
    persona_findings: {
      ux_lead: {
        orphan_pages_count: findingByType("orphan_page")?.affectedPageCount ?? 0,
        max_click_depth: allPages.length ? Math.max(...allPages.map((p) => p.depth)) : 0,
        accessibility_blockers: accessibilityBlockers,
      },
      content_strategist: {
        thin_content_urls: allPages.filter((p) => p.wordCount > 0 && p.wordCount < 150).map((p) => p.url),
        duplicate_clusters: duplicateClusters,
        missing_metadata_count:
          (findingByType("missing_title")?.affectedPageCount ?? 0) +
          (findingByType("missing_meta_description")?.affectedPageCount ?? 0),
        schema_coverage_percent: schemaCoveragePct,
      },
      business_analyst: {
        broken_routes_count: brokenRoutesCount,
        form_conversion_points: formConversionPoints,
        prioritized_backlog_items: prioritizedBacklogItems,
      },
    },
  };

  return NextResponse.json(payload, {
    headers: { "Content-Disposition": `attachment; filename="${auditId}-payload.json"` },
  });
}
