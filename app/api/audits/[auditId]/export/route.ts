import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import * as XLSX from "xlsx";
import { db } from "@/lib/db";
import { audits, findings, links, pages } from "@/lib/db/schema";
import { urlToNetloc } from "@/lib/url";
import {
  classifyIntegrations,
  countImagesAndMissingAlt,
  extractScripts,
  extractVisibleText,
  hasSchemaOrg,
  pathDepth,
  textHash,
  topKeywords,
  topPhrases,
} from "@/lib/reportAnalysis";

type Page = typeof pages.$inferSelect;
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

  const allPages = await db.select().from(pages).where(eq(pages.auditId, auditId));
  const allLinks = await db.select().from(links).where(eq(links.auditId, auditId));
  const allFindings = await db.select().from(findings).where(eq(findings.auditId, auditId));

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

  const heuristicRows = buildHeuristicEvaluation(allFindings);
  const heuristicSheet = XLSX.utils.json_to_sheet(heuristicRows);

  const actionPlanRows = buildActionPlan(allFindings);
  const actionPlanSheet = XLSX.utils.json_to_sheet(actionPlanRows);

  const overviewSheet = XLSX.utils.aoa_to_sheet([
    ["UX & IA Audit — Overview"],
    [],
    ["Client", audit.clientName],
    ["Site audited", audit.startUrl],
    ["Pages crawled", allPages.length],
    ["Findings", allFindings.length],
    ["Crawl started", audit.startedAt ? new Date(audit.startedAt).toISOString() : null],
    ["Crawl finished", audit.finishedAt ? new Date(audit.finishedAt).toISOString() : null],
  ]);

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

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, overviewSheet, "Overview");
  XLSX.utils.book_append_sheet(workbook, heuristicSheet, "Heuristic Evaluation");
  XLSX.utils.book_append_sheet(workbook, actionPlanSheet, "Action Plan");
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
function buildHeuristicEvaluation(allFindings: Finding[]) {
  const duplicateTitle = allFindings.find((f) => f.findingType === "duplicate_title");
  const brokenLinks = allFindings.find((f) => f.findingType === "broken_page");

  const rows: { Heuristic: string; "Assessed?": string; Status: string; "Top Finding": string }[] = [
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
      "Assessed?": duplicateTitle ? "Yes" : "No",
      Status: duplicateTitle ? `Severity 2 — ${duplicateTitle.affectedPageCount} finding(s)` : "Not assessed",
      "Top Finding": duplicateTitle?.title ?? "No consistency issues detected in this crawl.",
    },
    {
      Heuristic: "H5 — Error prevention",
      "Assessed?": "No",
      Status: "Not assessed",
      "Top Finding": "Needs form-submission testing — outside what a static crawl can observe.",
    },
    {
      Heuristic: "H6 — Recognition rather than recall",
      "Assessed?": "No",
      Status: "Not assessed",
      "Top Finding": "A judgment call about interface memory load — needs a human reviewer.",
    },
    {
      Heuristic: "H7 — Flexibility and efficiency of use",
      "Assessed?": "No",
      Status: "Not assessed",
      "Top Finding": "Requires testing with real users across skill levels — outside crawl scope.",
    },
    {
      Heuristic: "H8 — Aesthetic and minimalist design",
      "Assessed?": "No",
      Status: "Not assessed",
      "Top Finding": "A visual/subjective judgment — screenshots can support this review, but don't automate it.",
    },
    {
      Heuristic: "H9 — Help users recognize, diagnose, and recover from errors",
      "Assessed?": brokenLinks ? "Yes" : "No",
      Status: brokenLinks ? `Severity 3 — ${brokenLinks.affectedPageCount} finding(s)` : "Not assessed",
      "Top Finding": brokenLinks?.title ?? "No broken links detected in this crawl.",
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
    Area: AREA_BY_FINDING_TYPE[f.findingType] ?? "General",
    Action: f.title.charAt(0).toUpperCase() + f.title.slice(1) + ".",
  }));
}
