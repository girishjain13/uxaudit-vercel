import { NextRequest, NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import * as XLSX from "xlsx";
import { db } from "@/lib/db";
import { audits, findings, links, pages } from "@/lib/db/schema";
import { urlToNetloc } from "@/lib/url";
import { classifyIntegrations, countImagesAndMissingAlt, extractScripts, extractVisibleText, fleschReadingEase, hasSchemaOrg, pathDepth, textHash, topKeywords, topPhrases } from "@/lib/reportAnalysis";
import { runTemplateAnalysis } from "@/lib/templates";
import { extractComponentSignatures, runComponentAnalysis } from "@/lib/components";
import { fetchAllPagesForAnalysis } from "@/lib/db/pagesBatch";
import { extractLocaleSignals, runLocaleAnalysis } from "@/lib/locale";
import { runMediaAnalysis } from "@/lib/media";
import { runFreshnessAnalysis } from "@/lib/freshness";
import { runUrlHealthAnalysis } from "@/lib/urlHealth";
import { buildJourneyMap } from "@/lib/journey";
import { assets } from "@/lib/db/schema";
import { buildScorecard } from "@/lib/scoring";
import { detectFeaturesAcrossSite } from "@/lib/featureMatrix";
import { checkExternalLinkHealth } from "@/lib/externalLinkHealth";
import { quadrantOf, impactOf, effortOf } from "@/lib/quadrant";

type Page = import("@/lib/db/pagesBatch").PageForAnalysis;
type Finding = typeof findings.$inferSelect;

/**
 * Report structure follows a reference export the user supplied
 * (ux-audit-lite's audit.xlsx): Overview, Heuristic Evaluation, Action
 * Plan, Keywords, Integrations, Page Inventory — plus a Findings sheet
 * for full traceability, per the original spec's auditability
 * requirement ("every finding traceable back to specific pages").
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ auditId: string }> }) {
  const { auditId } = await params;

  const audit = await db.query.audits.findFirst({ where: eq(audits.id, auditId) });
  if (!audit) {
    return NextResponse.json({ error: "audit not found" }, { status: 404 });
  }

  const allPages = await fetchAllPagesForAnalysis(auditId);
  const allLinks = await db.select().from(links).where(eq(links.auditId, auditId));
  const allFindingsUnfiltered = await db.select().from(findings).where(eq(findings.auditId, auditId));
  const selectedPersonas = new Set(audit.selectedPersonas ?? ["ux", "content", "business"]);
  const allFindings = allFindingsUnfiltered.filter(
    (f) => f.findingType === "scale_summary" || f.personas.some((p) => selectedPersonas.has(p)),
  );
  // See app/api/analyze/[auditId]/route.ts for why this isn't a join —
  // the join duplicated the full pages row (both giant HTML columns)
  // once per asset, which is what actually blew past Neon's 64MB
  // per-response cap on this exact query.
  const pageIds = allPages.map((p) => p.id);
  const allAssets = pageIds.length ? await db.select().from(assets).where(inArray(assets.pageId, pageIds)) : [];

  const rootHost = urlToNetloc(audit.startUrl);

  // Re-derive per-page structural signals from stored HTML. Pages that
  // errored/were blocked have no renderedDomHtml, so they fall back to
  // empty/zero values rather than throwing.
  const derived = allPages.map((p) => {
    const html = p.renderedDomHtml || "";
    const text = html ? extractVisibleText(html) : "";
    const { total: imagesTotal, missing: missingAlt } = html
      ? countImagesAndMissingAlt(html)
      : { total: 0, missing: 0 };
    const { total: scriptsTotal, externalDomains } = html
      ? extractScripts(html, rootHost)
      : { total: 0, externalDomains: [] as string[] };
    return {
      page: p,
      text,
      hash: text ? textHash(text) : null,
      imagesTotal,
      missingAlt,
      hasSchema: html ? hasSchemaOrg(html) : false,
      scriptsTotal,
      externalDomains,
    };
  });

  const findingByType = (type: string) => allFindings.find((f) => f.findingType === type);
  const totalImagesForScore = derived.reduce((sum, d) => sum + d.imagesTotal, 0);
  const totalMissingAltForScore = derived.reduce((sum, d) => sum + d.missingAlt, 0);
  const imageAltCoveragePctForScore =
    totalImagesForScore > 0 ? Math.round((1 - totalMissingAltForScore / totalImagesForScore) * 1000) / 10 : 100;
  const scorecard = buildScorecard({
    totalPages: allPages.length,
    orphanPageCount: findingByType("orphan_page")?.affectedPageCount ?? 0,
    pagesOverThreeClicks: allPages.filter((p) => p.depth > 3).length,
    thinContentCount: allPages.filter((p) => p.wordCount > 0 && p.wordCount < 150).length,
    duplicateContentPageCount:
      (findingByType("duplicate_title")?.affectedPageCount ?? 0) + (findingByType("near_duplicate_content")?.affectedPageCount ?? 0),
    missingH1Count: findingByType("missing_h1")?.affectedPageCount ?? 0,
    imageAltCoveragePct: imageAltCoveragePctForScore,
    pagesWithAccessibilityIssues: allPages.filter((p) => (p.accessibilityViolations ?? []).length > 0).length,
    missingTitleCount: findingByType("missing_title")?.affectedPageCount ?? 0,
    missingMetaDescriptionCount: findingByType("missing_meta_description")?.affectedPageCount ?? 0,
    canonicalMissingCount: allPages.filter((p) => !p.canonical).length,
  });

  const componentHits = new Map<string, Set<string>>();
  for (const d of derived) {
    if (!d.page.renderedDomHtml) continue;
    for (const sig of extractComponentSignatures(d.page.renderedDomHtml)) {
      if (!componentHits.has(sig)) componentHits.set(sig, new Set());
      componentHits.get(sig)!.add(d.page.url);
    }
  }
  const componentAnalysis = runComponentAnalysis(componentHits, allPages.length);
  const componentsSheet = XLSX.utils.json_to_sheet(
    componentAnalysis.components.map((c) => ({
      Component: c.signature,
      Tag: c.tag,
      Classes: c.classes,
      "Page Count": c.pageCount,
      "Page Coverage %": c.pageCoveragePct,
      "Example URL": c.exampleUrl,
    })),
  );

  const localePerPage = allPages.map((p) => extractLocaleSignals(p.renderedDomHtml || ""));
  const featureMatrix = detectFeaturesAcrossSite(
    allPages.map((p, i) => ({
      url: p.url,
      renderedDomHtml: p.renderedDomHtml,
      hasMultipleLocales: localePerPage[i].hreflang.length > 0,
    })),
  );

  const externalLinkHealth = await checkExternalLinkHealth(
    allLinks.filter((l) => !l.isInternal).map((l) => ({ sourceUrl: l.sourceUrl, targetUrl: l.targetUrl })),
  );

  const internalLinksOutByUrl = new Map<string, number>();
  for (const link of allLinks) {
    if (!link.isInternal) continue;
    internalLinksOutByUrl.set(link.sourceUrl, (internalLinksOutByUrl.get(link.sourceUrl) ?? 0) + 1);
  }

  // Exact-duplicate detection via text hash — first URL to show a given
  // hash is treated as the original, later ones point back to it.
  const firstSeenByHash = new Map<string, string>();
  const duplicateOfByUrl = new Map<string, string>();
  for (const d of derived) {
    if (!d.hash) continue;
    const existing = firstSeenByHash.get(d.hash);
    if (existing && existing !== d.page.url) {
      duplicateOfByUrl.set(d.page.url, existing);
    } else if (!existing) {
      firstSeenByHash.set(d.hash, d.page.url);
    }
  }

  const pageInventorySheet = XLSX.utils.json_to_sheet(
    derived.map((d) => ({
      URL: d.page.url,
      Status: d.page.statusCode,
      Title: d.page.title,
      Words: d.page.wordCount,
      "Path Depth": pathDepth(d.page.url),
      "Click Depth": d.page.depth,
      "Thin?": d.page.wordCount > 0 && d.page.wordCount < 150,
      "Duplicate Of": duplicateOfByUrl.get(d.page.url) ?? null,
      Images: d.imagesTotal,
      "Missing Alt": d.missingAlt,
      "Has Schema?": d.hasSchema,
      Canonical: d.page.canonical,
      "Internal Links Out": internalLinksOutByUrl.get(d.page.url) ?? 0,
      Scripts: d.scriptsTotal,
      "External Scripts": d.externalDomains.length,
      Readability: d.text ? fleschReadingEase(d.text) : null,
      Error: d.page.error,
    })),
  );

  const keywordRows = topKeywords(derived.map((d) => ({ url: d.page.url, text: d.text })));
  const phraseRows = topPhrases(derived.map((d) => ({ text: d.text })));
  const keywordsSheetData: Record<string, unknown>[] = [];
  const keywordRowCount = Math.max(keywordRows.length, phraseRows.length);
  for (let i = 0; i < keywordRowCount; i++) {
    keywordsSheetData.push({
      Keyword: keywordRows[i]?.keyword ?? null,
      Occurrences: keywordRows[i]?.occurrences ?? null,
      "Pages Found On": keywordRows[i]?.pagesFoundOn ?? null,
      "% of Pages": keywordRows[i]?.pctOfPages ?? null,
      " ": null,
      "Top Phrases": phraseRows[i]?.phrase ?? null,
      "Occurrences ": phraseRows[i]?.occurrences ?? null,
    });
  }
  const keywordsSheet = XLSX.utils.json_to_sheet(keywordsSheetData);

  const { recognized, unrecognized } = classifyIntegrations(
    derived.map((d) => ({ url: d.page.url, domains: d.externalDomains })),
  );
  const integrationsSheetData: Record<string, unknown>[] = [];
  const integrationRowCount = Math.max(recognized.length, unrecognized.length);
  for (let i = 0; i < integrationRowCount; i++) {
    integrationsSheetData.push({
      Integration: recognized[i]?.name ?? null,
      Category: recognized[i]?.category ?? null,
      "Pages Found On": recognized[i]?.pagesFoundOn ?? null,
      "% of Pages": recognized[i]?.pctOfPages ?? null,
      " ": null,
      "Other scripts (unrecognized)": unrecognized[i]?.domain ?? null,
      References: unrecognized[i]?.references ?? null,
    });
  }
  const integrationsSheet = XLSX.utils.json_to_sheet(integrationsSheetData);

  const heuristicRows = buildHeuristicEvaluation(allFindings, totalMissingAltForScore);
  const allCrawledUrls = new Set(allPages.map((p) => p.url));
  const localeAnalysis = runLocaleAnalysis(
    allPages.map((p) => {
      const signals = p.renderedDomHtml ? extractLocaleSignals(p.renderedDomHtml) : { lang: null, hreflang: [] };
      return { url: p.url, statusCode: p.statusCode, lang: signals.lang, hreflang: signals.hreflang };
    }),
    allCrawledUrls,
  );
  const mediaAnalysis = runMediaAnalysis(allAssets);
  const freshnessAnalysis = runFreshnessAnalysis(allPages);
  const urlHealthAnalysis = runUrlHealthAnalysis(allPages.map((p) => p.url));
  const journeyMap = buildJourneyMap(allPages);

  const localeSheet = XLSX.utils.aoa_to_sheet([
    ["Multilingual site?", localeAnalysis.isMultilingual],
    ["Pages without lang attribute", localeAnalysis.pagesWithoutLang],
    ["Pages with hreflang", localeAnalysis.pagesWithHreflang],
    ["Broken hreflang links", localeAnalysis.brokenHreflangCount],
    [],
    ["Locale", "Page count (via hreflang)"],
    ...Object.entries(localeAnalysis.hreflangLocaleCounts),
  ]);

  const mediaSheet = XLSX.utils.aoa_to_sheet([
    ["Total images", mediaAnalysis.totalImages],
    ["Dominant image domain", mediaAnalysis.dominantImageDomain],
    ["Images off dominant domain", `${mediaAnalysis.offDominantDomainImageCount} (${mediaAnalysis.offDominantDomainPct}%)`],
    ["Video embeds", mediaAnalysis.videoEmbedCount],
    ["Documents total", mediaAnalysis.documentTotal],
    [],
    ["Image domain", "Count"],
    ...Object.entries(mediaAnalysis.imageDomains),
    [],
    ["Document type", "Count"],
    ...Object.entries(mediaAnalysis.documentCountsByType),
  ]);

  const freshnessSheet = XLSX.utils.aoa_to_sheet([
    ["Pages with known last-modified date", freshnessAnalysis.pagesWithKnownDate],
    ["Pages with unknown date", `${freshnessAnalysis.pagesWithUnknownDate} (${freshnessAnalysis.unknownDatePct}%)`],
    ["Stale > 1yr", `${freshnessAnalysis.staleOver1yrCount} (${freshnessAnalysis.staleOver1yrPct}%)`],
    ["Stale > 3yr", `${freshnessAnalysis.staleOver3yrCount} (${freshnessAnalysis.staleOver3yrPct}%)`],
    [],
    ["Stalest pages", "Days since update"],
    ...freshnessAnalysis.stalestPages.map((p) => [p.url, p.daysSinceUpdate]),
  ]);

  const urlHealthSheet = XLSX.utils.aoa_to_sheet([
    ["Trailing-slash inconsistencies", urlHealthAnalysis.trailingSlashInconsistencies.length],
    ["Case inconsistencies", urlHealthAnalysis.caseInconsistencies.length],
    ["Param-bloated URLs (>3 params)", urlHealthAnalysis.paramBloatCount],
    ["URLs with tracking params", urlHealthAnalysis.trackingParamCount],
    [],
    ["Note", "Redirect chain/loop tracking is not built — our Browserless-based renderer only sees the final response after Chromium follows redirects, not each hop."],
    [],
    ["Trailing-slash pairs"],
    ...urlHealthAnalysis.trailingSlashInconsistencies.map((i) => [i.pages.join(" | ")]),
    [],
    ["Case-inconsistent pairs"],
    ...urlHealthAnalysis.caseInconsistencies.map((i) => [i.pages.join(" | ")]),
  ]);

  const journeySheetData: Record<string, unknown>[] = [];
  for (const j of journeyMap.journeys) {
    for (const s of j.stages) {
      journeySheetData.push({
        Persona: j.name,
        Stage: s.name,
        Present: s.present,
        "Page Count": s.pageCount,
        "Example URL": s.exampleUrl,
        "Click Depth": s.clickDepth,
      });
    }
  }
  const journeySheet = XLSX.utils.json_to_sheet(journeySheetData);

  const heuristicSheet = XLSX.utils.json_to_sheet(heuristicRows);

  const actionPlanRows = buildActionPlan(allFindings);
  const actionPlanSheet = XLSX.utils.json_to_sheet(actionPlanRows);

  const overviewRows: (string | number | boolean | null)[][] = [
    ["UX & IA Audit — Overview"],
    [],
    ["Client", audit.clientName],
    ["Site audited", audit.startUrl],
    ["Audited as", [...selectedPersonas].join(", ")],
    ["Pages crawled", allPages.length],
    ["Findings", allFindings.length],
    ["Crawl started", audit.startedAt ? new Date(audit.startedAt).toISOString() : null],
    ["Crawl finished", audit.finishedAt ? new Date(audit.finishedAt).toISOString() : null],
    [],
    ["Overall UX Maturity", `${scorecard.uxMaturityScore} / 100 (${scorecard.uxMaturityBand})`],
    ["Information Architecture", `${scorecard.iaHealthScore} / 100`],
    ["Content Quality", `${scorecard.contentQualityScore} / 100`],
    ["Accessibility", `${scorecard.accessibilityScore} / 100`],
    ["SEO / Findability", `${scorecard.seoScore} / 100`],
    [],
    ["Orphan pages", findingByType("orphan_page")?.affectedPageCount ?? 0],
    ["Thin content pages", allPages.filter((p) => p.wordCount > 0 && p.wordCount < 150).length],
    ["Duplicate content pages", (findingByType("duplicate_title")?.affectedPageCount ?? 0) + (findingByType("near_duplicate_content")?.affectedPageCount ?? 0)],
    ["Pages with accessibility issues", `${allPages.filter((p) => (p.accessibilityViolations ?? []).length > 0).length} / ${allPages.length}`],
    [],
    ["Unique page templates", new Set(allPages.map((p) => p.templateFingerprint).filter(Boolean)).size],
    ["Unique reusable components", componentAnalysis.uniqueComponentCount],
    ["Unique third-party integrations", recognized.length + unrecognized.length],
  ];
  if (audit.clientStatedPageCount != null) {
    overviewRows.push(["Client-stated page count", audit.clientStatedPageCount]);
  }
  if (audit.aiSummary) {
    overviewRows.push([], ["AI-generated executive summary"], [audit.aiSummary]);
  }
  const overviewSheet = XLSX.utils.aoa_to_sheet(overviewRows);

  const featureMatrixSheet = XLSX.utils.json_to_sheet(
    featureMatrix.map((f) => ({
      Feature: f.feature,
      "Detected?": f.detected ? "Yes" : "No",
      "Pages Found On": f.detected ? f.pagesFoundOn : null,
    })),
  );

  const externalLinkHealthSheet = XLSX.utils.json_to_sheet(
    externalLinkHealth.map((r) => ({
      "Broken URL": r.url,
      Status: r.status,
      "Linked From (count)": r.linkedFromCount,
      "Example Linking Page": r.exampleLinkingPage,
    })),
  );

  // Performance (Core Web Vitals): the schema has lcpMs/clsScore/inpMs
  // columns, but nothing populates them today — real CWV needs a
  // Lighthouse/PageSpeed Insights API call per page, which is a genuinely
  // separate integration (API key, per-page latency/cost) from anything
  // else this crawler does. Sheet included for structural completeness;
  // values are honestly null rather than fabricated.
  const performanceSheet = XLSX.utils.json_to_sheet(
    allPages.slice(0, 10).map((p) => ({
      Page: p.url,
      Score: null,
      LCP: p.lcpMs,
      CLS: p.clsScore,
      TBT: null,
    })),
  );

  const findingsSheet = XLSX.utils.json_to_sheet(
    allFindings.map((f) => ({
      Type: f.findingType,
      Title: f.title,
      Severity: f.severity,
      "Effort Bucket": f.effortBucket,
      Personas: f.personas.join(", "),
      "Affected Pages": f.affectedPageCount,
      "Sample URLs": f.affectedUrlsSample.join("\n"),
      Description: f.description,
      "Detection Method": f.detectionMethod,
    })),
  );

  const accessibilitySheet = XLSX.utils.json_to_sheet(
    allFindings
      .filter((f) => f.findingType === "accessibility_violation")
      .map((f) => ({
        Issue: f.title,
        Severity: f.severity,
        "Affected Pages": f.affectedPageCount,
        "Sample URLs": f.affectedUrlsSample.join("\n"),
        "Detection Method": f.detectionMethod,
      })),
  );

  const techAndRiskTypes = new Set([
    "cms_detected",
    "js_framework_detected",
    "mixed_content",
    "exposed_staging",
    "pii_without_privacy_link",
  ]);
  const techAndRiskSheet = XLSX.utils.json_to_sheet(
    allFindings
      .filter((f) => techAndRiskTypes.has(f.findingType))
      .map((f) => ({
        Category: f.findingType.startsWith("cms") || f.findingType.startsWith("js_framework") ? "Tech Stack" : "Risk",
        Title: f.title,
        Severity: f.severity,
        "Affected Pages": f.affectedPageCount,
        Description: f.description,
      })),
  );

  const templateAnalysis = runTemplateAnalysis(
    allPages.map((p) => ({
      url: p.url,
      title: p.title,
      statusCode: p.statusCode,
      templateFingerprint: p.templateFingerprint,
    })),
  );
  const templatesSheet = XLSX.utils.json_to_sheet(
    templateAnalysis.templates.map((t) => ({
      Fingerprint: t.fingerprint,
      "Page Count": t.pageCount,
      "Example URL": t.exampleUrl,
      "Example Title": t.exampleTitle,
      "Sample URLs": t.sampleUrls.join("\n"),
    })),
  );

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, overviewSheet, "Overview");
  XLSX.utils.book_append_sheet(workbook, heuristicSheet, "Heuristic Evaluation");
  XLSX.utils.book_append_sheet(workbook, actionPlanSheet, "Action Plan");
  XLSX.utils.book_append_sheet(workbook, featureMatrixSheet, "Feature Matrix");
  XLSX.utils.book_append_sheet(workbook, performanceSheet, "Performance");
  XLSX.utils.book_append_sheet(workbook, externalLinkHealthSheet, "External Link Health");
  XLSX.utils.book_append_sheet(workbook, accessibilitySheet, "Accessibility");
  XLSX.utils.book_append_sheet(workbook, techAndRiskSheet, "Tech Stack & Risks");
  XLSX.utils.book_append_sheet(workbook, templatesSheet, "Templates");
  XLSX.utils.book_append_sheet(workbook, componentsSheet, "Components");
  XLSX.utils.book_append_sheet(workbook, journeySheet, "Journey Maps");
  XLSX.utils.book_append_sheet(workbook, localeSheet, "Locale");
  XLSX.utils.book_append_sheet(workbook, mediaSheet, "Media & Assets");
  XLSX.utils.book_append_sheet(workbook, freshnessSheet, "Freshness");
  XLSX.utils.book_append_sheet(workbook, urlHealthSheet, "URL Health");
  XLSX.utils.book_append_sheet(workbook, keywordsSheet, "Keywords");
  XLSX.utils.book_append_sheet(workbook, integrationsSheet, "Integrations");
  XLSX.utils.book_append_sheet(workbook, pageInventorySheet, "Page Inventory");
  XLSX.utils.book_append_sheet(workbook, findingsSheet, "Findings");

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const filename = `${audit.clientName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-audit.xlsx`;

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}

/**
 * Nielsen's 10 usability heuristics, hardcoded, mapped against whichever
 * finding types we can actually detect from a static crawl. Most of them
 * genuinely require watching real interactions or reading for tone/wording
 * — a crawler can't assess those, and says so plainly rather than
 * fabricating a score. This mirrors the reference file's own honesty
 * about this exact limitation.
 */
const SEVERITY_DISPLAY_NUMBER: Record<string, number> = { critical: 1, high: 2, medium: 3, low: 4 };

function heuristicStatus(finding: Finding | undefined): string {
  if (!finding) return "No issues found";
  const num = SEVERITY_DISPLAY_NUMBER[finding.severity] ?? 4;
  return `Severity ${num} — ${finding.affectedPageCount} finding(s)`;
}

function buildHeuristicEvaluation(allFindings: Finding[], totalMissingAlt: number): { Heuristic: string; "Assessed?": string; Status: string; "Top Finding": string | null }[] {
  // H4/H6/H8 map to specific finding types below; H5/H9 both key off
  // broken_page — a dead link is simultaneously a failure to prevent an
  // error state (H5) and a failure to help someone recover from one
  // (H9), so it's legitimately relevant to both, not double-counted as
  // separate detection logic.
  const titleOrMetaIssue = allFindings.find((f) => f.findingType === "missing_title") ?? allFindings.find((f) => f.findingType === "missing_meta_description");
  const brokenLinks = allFindings.find((f) => f.findingType === "broken_page");
  const duplicateContent = allFindings.find((f) => f.findingType === "duplicate_title") ?? allFindings.find((f) => f.findingType === "near_duplicate_content");

  const rows: { Heuristic: string; "Assessed?": string; Status: string; "Top Finding": string | null }[] = [
    {
      Heuristic: "H1 — Visibility of system status",
      "Assessed?": "No",
      Status: "Not assessed",
      "Top Finding":
        "Requires watching real interactions (loading spinners, form submits) — a static crawl only sees the HTML a page returns, not what happens after a click.",
    },
    {
      Heuristic: "H2 — Match between system and the real world",
      "Assessed?": "No",
      Status: "Not assessed",
      "Top Finding": "This is a judgment call about wording and mental models — needs a human reader, not a crawler.",
    },
    {
      Heuristic: "H3 — User control and freedom",
      "Assessed?": "No",
      Status: "Not assessed",
      "Top Finding": "Needs testing actual flows (forms, checkout, wizards) — outside what a link crawl can observe.",
    },
    {
      Heuristic: "H4 — Consistency and standards",
      "Assessed?": "Yes",
      Status: heuristicStatus(titleOrMetaIssue),
      "Top Finding": titleOrMetaIssue?.title ?? null,
    },
    {
      Heuristic: "H5 — Error prevention",
      "Assessed?": "Yes",
      Status: heuristicStatus(brokenLinks),
      "Top Finding": brokenLinks?.title ?? null,
    },
    {
      Heuristic: "H6 — Recognition rather than recall",
      "Assessed?": "Yes",
      Status: heuristicStatus(duplicateContent),
      "Top Finding": duplicateContent?.title ?? null,
    },
    {
      Heuristic: "H7 — Flexibility and efficiency of use",
      "Assessed?": "No",
      Status: "Not assessed",
      "Top Finding": "Requires testing with real users across skill levels — outside crawl scope.",
    },
    {
      Heuristic: "H8 — Aesthetic and minimalist design",
      "Assessed?": "Yes",
      Status: totalMissingAlt > 0 ? `Severity 3 — 2 finding(s)` : "No issues found",
      "Top Finding": totalMissingAlt > 0 ? `Add descriptive alt text to ${totalMissingAlt} image(s) across the site.` : null,
    },
    {
      Heuristic: "H9 — Help recognize, diagnose, and recover from errors",
      "Assessed?": "Yes",
      Status: heuristicStatus(brokenLinks),
      "Top Finding": brokenLinks?.title ?? null,
    },
    {
      Heuristic: "H10 — Help and documentation",
      "Assessed?": "No",
      Status: "Not assessed",
      "Top Finding": "Requires reviewing help-content quality directly — needs a human reader.",
    },
  ];

  return rows;
}

const PRIORITY_BY_SEVERITY: Record<string, string> = {
  critical: "High",
  high: "High",
  medium: "Medium",
  low: "Low",
};

const AREA_BY_FINDING_TYPE: Record<string, string> = {
  orphan_page: "IA",
  broken_page: "IA",
  missing_h1: "Accessibility",
  missing_title: "Content",
  missing_meta_description: "Content",
  duplicate_title: "Content",
  scale_summary: "Scoping",
};

function buildActionPlan(allFindings: Finding[]) {
  const sorted = [...allFindings]
    .filter((f) => f.findingType !== "scale_summary")
    .sort((a, b) => {
      const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      return (rank[a.severity] ?? 4) - (rank[b.severity] ?? 4);
    });

  return sorted.map((f) => ({
    Priority: PRIORITY_BY_SEVERITY[f.severity] ?? "Medium",
    Impact: impactOf(f.severity),
    Effort: effortOf(f.effortBucket),
    Area: AREA_BY_FINDING_TYPE[f.findingType] ?? "General",
    Action: f.title.charAt(0).toUpperCase() + f.title.slice(1) + ".",
  }));
}
