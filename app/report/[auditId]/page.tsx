import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { AlertTriangle, CheckCircle2, Copy, Download, FileJson, FileSpreadsheet, Printer } from "lucide-react";
import { db } from "@/lib/db";
import { audits, findings, links } from "@/lib/db/schema";
import { fetchAllPagesForAnalysis } from "@/lib/db/pagesBatch";
import { countImagesAndMissingAlt } from "@/lib/reportAnalysis";
import { buildScorecard } from "@/lib/scoring";
import { generateInPlainTerms, generateUxLeadAssessment } from "@/lib/narrative";
import { PrintButton } from "@/app/report/PrintButton";

export const dynamic = "force-dynamic";

const PRIORITY_BY_SEVERITY: Record<string, "high" | "medium" | "low"> = {
  critical: "high",
  high: "high",
  medium: "medium",
  low: "low",
};

const AREA_BY_FINDING_TYPE: Record<string, string> = {
  orphan_page: "IA",
  broken_page: "IA",
  missing_h1: "Content",
  missing_title: "SEO",
  missing_meta_description: "SEO",
  duplicate_title: "SEO",
  near_duplicate_content: "Content",
  low_readability: "Content",
  accessibility_violation: "Accessibility",
  mixed_content: "Risk",
  exposed_staging: "Risk",
  pii_without_privacy_link: "Risk",
  cms_detected: "Tech Stack",
  js_framework_detected: "Tech Stack",
};

const EFFORT_LABEL: Record<string, string> = {
  ootb: "Configuration effort",
  config: "Configuration effort",
  custom_dev: "Developer effort",
};

function tierClasses(score: number): { bg: string; text: string; border: string } {
  if (score >= 70) return { bg: "bg-emerald-50", text: "text-emerald-700", border: "border-emerald-200" };
  if (score >= 50) return { bg: "bg-amber-50", text: "text-amber-700", border: "border-amber-200" };
  return { bg: "bg-rose-50", text: "text-rose-700", border: "border-rose-200" };
}

export default async function ReportPage({ params }: { params: Promise<{ auditId: string }> }) {
  const { auditId } = await params;

  const audit = await db.query.audits.findFirst({ where: eq(audits.id, auditId) });
  if (!audit) notFound();

  const allPages = await fetchAllPagesForAnalysis(auditId);
  const allLinks = await db.select().from(links).where(eq(links.auditId, auditId));
  const allFindingsUnfiltered = await db.select().from(findings).where(eq(findings.auditId, auditId));
  const selectedPersonas = new Set(audit.selectedPersonas ?? ["ux", "content", "business"]);
  const allFindings = allFindingsUnfiltered.filter(
    (f) => f.findingType === "scale_summary" || f.personas.some((p) => selectedPersonas.has(p)),
  );

  // --- Scorecard ---
  let totalImages = 0;
  let totalMissingAlt = 0;
  for (const p of allPages) {
    if (!p.renderedDomHtml) continue;
    const { total, missing } = countImagesAndMissingAlt(p.renderedDomHtml);
    totalImages += total;
    totalMissingAlt += missing;
  }
  const imageAltCoveragePct = totalImages > 0 ? Math.round((1 - totalMissingAlt / totalImages) * 1000) / 10 : 100;
  const findingByType = (type: string) => allFindings.find((f) => f.findingType === type);
  const pagesWithA11yIssues = allPages.filter((p) => (p.accessibilityViolations ?? []).length > 0).length;

  const scorecard = buildScorecard({
    totalPages: allPages.length,
    orphanPageCount: findingByType("orphan_page")?.affectedPageCount ?? 0,
    pagesOverThreeClicks: allPages.filter((p) => p.depth > 3).length,
    thinContentCount: allPages.filter((p) => p.wordCount > 0 && p.wordCount < 150).length,
    duplicateContentPageCount:
      (findingByType("duplicate_title")?.affectedPageCount ?? 0) + (findingByType("near_duplicate_content")?.affectedPageCount ?? 0),
    missingH1Count: findingByType("missing_h1")?.affectedPageCount ?? 0,
    imageAltCoveragePct,
    pagesWithAccessibilityIssues: pagesWithA11yIssues,
    missingTitleCount: findingByType("missing_title")?.affectedPageCount ?? 0,
    missingMetaDescriptionCount: findingByType("missing_meta_description")?.affectedPageCount ?? 0,
    canonicalMissingCount: allPages.filter((p) => !p.canonical).length,
  });

  // --- Coverage bar ---
  const pageErrors = allPages.filter((p) => p.error).length;
  const coverageComplete = allPages.length < audit.maxPages;
  const durationSeconds =
    audit.startedAt && audit.finishedAt ? Math.round((new Date(audit.finishedAt).getTime() - new Date(audit.startedAt).getTime()) / 100) / 10 : null;

  // --- Warning banner: client-rendered pages with zero internal links out is the classic false-orphan trap ---
  const internalLinksOutByUrl = new Map<string, number>();
  for (const link of allLinks) {
    if (link.isInternal) internalLinksOutByUrl.set(link.sourceUrl, (internalLinksOutByUrl.get(link.sourceUrl) ?? 0) + 1);
  }
  const clientRenderedZeroLinkPages = allPages.filter((p) => p.isClientRendered && (internalLinksOutByUrl.get(p.url) ?? 0) === 0);
  const showJsRenderingWarning = clientRenderedZeroLinkPages.length > 0;

  // --- Narrative sections (template-based, not AI) ---
  const narrativeInputs = {
    scorecard,
    totalPages: allPages.length,
    orphanPageCount: findingByType("orphan_page")?.affectedPageCount ?? 0,
    brokenLinkCount: findingByType("broken_page")?.affectedPageCount ?? 0,
    missingH1Count: findingByType("missing_h1")?.affectedPageCount ?? 0,
    missingTitleCount: findingByType("missing_title")?.affectedPageCount ?? 0,
    missingMetaDescriptionCount: findingByType("missing_meta_description")?.affectedPageCount ?? 0,
    accessibilityIssuePages: pagesWithA11yIssues,
    duplicateContentCount:
      (findingByType("duplicate_title")?.affectedPageCount ?? 0) + (findingByType("near_duplicate_content")?.affectedPageCount ?? 0),
    thinContentCount: allPages.filter((p) => p.wordCount > 0 && p.wordCount < 150).length,
    maxClickDepth: allPages.length ? Math.max(...allPages.map((p) => p.depth)) : 0,
  };
  const plainTerms = generateInPlainTerms(narrativeInputs);
  const uxLeadAssessment = generateUxLeadAssessment(narrativeInputs);

  // --- Heuristics ---
  const duplicateTitle = findingByType("duplicate_title");
  const brokenLinks = findingByType("broken_page");
  const heuristics = [
    { id: "h1", name: "H1 — Visibility of system status", assessed: false, reason: "Requires watching real interactions — a static crawl only sees returned HTML." },
    { id: "h2", name: "H2 — Match between system and the real world", assessed: false, reason: "A judgment call about wording — needs a human reader." },
    { id: "h3", name: "H3 — User control and freedom", assessed: false, reason: "Needs testing real flows (forms, checkout) — outside crawl scope." },
    { id: "h4", name: "H4 — Consistency and standards", assessed: Boolean(duplicateTitle), severity: duplicateTitle?.severity, count: duplicateTitle?.affectedPageCount, finding: duplicateTitle?.title },
    { id: "h5", name: "H5 — Error prevention", assessed: false, reason: "Needs form-submission testing." },
    { id: "h6", name: "H6 — Recognition rather than recall", assessed: false, reason: "A judgment call about interface memory load." },
    { id: "h7", name: "H7 — Flexibility and efficiency of use", assessed: false, reason: "Requires testing with real users across skill levels." },
    { id: "h8", name: "H8 — Aesthetic and minimalist design", assessed: false, reason: "A visual/subjective judgment call." },
    { id: "h9", name: "H9 — Help users recognize, diagnose, and recover from errors", assessed: Boolean(brokenLinks), severity: brokenLinks?.severity, count: brokenLinks?.affectedPageCount, finding: brokenLinks?.title },
    { id: "h10", name: "H10 — Help and documentation", assessed: false, reason: "Requires reviewing help-content quality directly." },
  ];

  // --- Action plan + impact/effort ---
  const actionPlan = [...allFindings]
    .filter((f) => f.findingType !== "scale_summary")
    .sort((a, b) => {
      const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      return (rank[a.severity] ?? 4) - (rank[b.severity] ?? 4);
    });

  const impactOf = (severity: string) => (severity === "critical" || severity === "high" ? "High" : "Low");
  const effortOf = (bucket: string) => (bucket === "custom_dev" ? "High" : bucket === "config" ? "Medium" : "Low");
  const effortX = (effort: string) => (effort === "Low" ? 20 : effort === "Medium" ? 50 : 85);
  const impactY = (impact: string) => (impact === "High" ? 20 : 85);

  const techStackFindings = allFindings.filter((f) => f.findingType === "cms_detected" || f.findingType === "js_framework_detected");
  const riskFindings = allFindings.filter(
    (f) => f.findingType === "mixed_content" || f.findingType === "exposed_staging" || f.findingType === "pii_without_privacy_link",
  );

  return (
    <main className="min-h-screen bg-[#f8fafc] text-slate-900" style={{ fontFamily: "var(--font-sans)" }}>
      <div className="mx-auto max-w-6xl px-6 py-10">
        {/* Header */}
        <div className="mb-8">
          <span className="inline-block rounded-full bg-slate-900 px-3 py-1 text-xs font-medium text-white mb-4">
            UX &amp; Information Architecture Audit
          </span>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold text-slate-900 break-all">{audit.startUrl}</h1>
            <Copy className="h-4 w-4 text-slate-400 shrink-0" aria-hidden />
          </div>
          <p className="mt-2 max-w-2xl text-sm text-slate-500">
            A heuristic evaluation generated from a {allPages.length}-page crawl — read it the way you'd read a colleague's
            design review, not a server log.
          </p>

          <div className="mt-4 flex flex-wrap gap-2">
            <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600">
              Pages reviewed: {allPages.length}
            </span>
            <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600">
              Crawled: {audit.finishedAt ? new Date(audit.finishedAt).toLocaleDateString() : "—"}
            </span>
            {durationSeconds !== null && (
              <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600">
                Duration: {durationSeconds}s
              </span>
            )}
            <span className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs text-slate-600">
              Audited as: {[...selectedPersonas].join(", ")}
            </span>
          </div>

          <div className="mt-5 flex flex-wrap gap-2 print:hidden">
            <a href={`/api/audits/${auditId}/payload`} className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
              <FileJson className="h-3.5 w-3.5" /> Export JSON
            </a>
            <a href={`/api/audits/${auditId}/csv`} className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
              <Download className="h-3.5 w-3.5" /> Export CSV
            </a>
            <a href={`/api/audits/${auditId}/export`} className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50">
              <FileSpreadsheet className="h-3.5 w-3.5" /> Export XLSX
            </a>
            <PrintButton />
          </div>
        </div>

        {/* Audit Coverage */}
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Audit Coverage</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <CoverageCard label="Pages Crawled" value={allPages.length} />
            <CoverageCard label="Crawl Limit" value={audit.maxPages} />
            <CoverageCard label="Page Errors" value={pageErrors} tone={pageErrors > 0 ? "warn" : "ok"} />
            <CoverageCard label="Crawl Coverage" value={coverageComplete ? "Complete" : "Partial"} tone={coverageComplete ? "ok" : "warn"} />
          </div>
          <p className="mt-2 text-xs text-slate-500">
            {coverageComplete
              ? "The crawl finished naturally without hitting the page-limit cap — this reflects the site's full discoverable structure from the homepage."
              : `The crawl stopped at the ${audit.maxPages}-page limit before exhausting all discoverable links — the site likely has more pages than shown here.`}
          </p>
        </section>

        {/* Warning banner */}
        {showJsRenderingWarning && (
          <section className="mb-8 flex gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4">
            <AlertTriangle className="h-5 w-5 shrink-0 text-amber-600" />
            <div>
              <p className="text-sm font-medium text-amber-800">Client-side rendering may be undercounting internal links</p>
              <p className="mt-1 text-sm text-amber-700">
                {clientRenderedZeroLinkPages.length} page(s) appear to be primarily client-rendered and show zero discovered
                internal links out — a common signature of a JS framework mounting navigation after this crawl's render
                wait completed. Some "orphan page" findings on this report may be false positives caused by this, not
                genuinely unlinked content. Worth spot-checking a few of these pages manually before treating them as
                confirmed IA issues.
              </p>
            </div>
          </section>
        )}

        {/* In Plain Terms */}
        <section className="mb-8 rounded-lg border border-slate-200 bg-white p-6">
          <h2 className="mb-3 text-base font-semibold text-slate-900">In Plain Terms</h2>
          <ul className="space-y-2">
            {plainTerms.map((bullet, i) => (
              <li key={i} className="flex gap-2 text-sm text-slate-600">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
                {bullet}
              </li>
            ))}
          </ul>
        </section>

        {/* UX Lead's Assessment */}
        <section className="mb-8 rounded-lg border border-slate-200 bg-white p-6">
          <h2 className="mb-3 text-base font-semibold text-slate-900">UX Lead's Assessment</h2>
          <div className="space-y-3">
            {uxLeadAssessment.map((para, i) => (
              <p key={i} className="text-sm leading-relaxed text-slate-600">
                {para}
              </p>
            ))}
          </div>
        </section>

        {/* Scorecard */}
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Scorecard</h2>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            <ScoreTile label="Overall UX Maturity" value={scorecard.uxMaturityScore} subtitle={scorecard.uxMaturityBand} />
            <ScoreTile label="Information Architecture" value={scorecard.iaHealthScore} subtitle="Click depth, orphan ratio" />
            <ScoreTile label="Content Quality" value={scorecard.contentQualityScore} subtitle="Thin/duplicate, headings" />
            <ScoreTile label="Accessibility" value={scorecard.accessibilityScore} subtitle="Automated WCAG signals" />
            <ScoreTile label="SEO & Findability" value={scorecard.seoScore} subtitle="Titles, meta, canonicals" />
          </div>
        </section>

        {/* Heuristics */}
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Nielsen's 10 Heuristics</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {heuristics.map((h) => (
              <div key={h.id} className={`rounded-lg border p-4 ${h.assessed ? "border-slate-200 bg-white" : "border-slate-200 bg-slate-50"}`}>
                <div className="flex items-start justify-between gap-2">
                  <h3 className="text-sm font-medium text-slate-800">{h.name}</h3>
                  {h.assessed ? (
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${tierClasses(100 - (h.severity === "critical" || h.severity === "high" ? 80 : 40)).bg} ${tierClasses(100 - (h.severity === "critical" || h.severity === "high" ? 80 : 40)).text}`}>
                      Severity: {h.severity}
                    </span>
                  ) : (
                    <span className="shrink-0 rounded-full border border-dashed border-slate-300 px-2 py-0.5 text-[10px] text-slate-400">
                      Not assessed
                    </span>
                  )}
                </div>
                <p className="mt-1.5 text-xs text-slate-500">
                  {h.assessed ? `${h.finding} (${h.count} page(s) affected)` : h.reason}
                </p>
              </div>
            ))}
          </div>
        </section>

        {/* Integrations & Tech Stack */}
        {(techStackFindings.length > 0 || riskFindings.length > 0) && (
          <section className="mb-8 grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-slate-200 bg-white p-5">
              <h2 className="mb-3 text-sm font-semibold text-slate-900">Tech Stack &amp; Integrations</h2>
              {techStackFindings.length === 0 ? (
                <p className="text-xs text-slate-500">No CMS or JS framework signatures were recognized during this crawl.</p>
              ) : (
                <ul className="space-y-2">
                  {techStackFindings.map((f) => (
                    <li key={f.id} className="flex items-start justify-between gap-2 text-sm">
                      <span className="text-slate-700">{f.title}</span>
                      <span className="shrink-0 text-xs text-slate-400">{f.affectedPageCount} page(s)</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div className="rounded-lg border border-slate-200 bg-white p-5">
              <h2 className="mb-3 text-sm font-semibold text-slate-900">Risk Flags</h2>
              {riskFindings.length === 0 ? (
                <p className="text-xs text-slate-500">No mixed-content, exposed-staging, or PII-without-privacy-link risks detected.</p>
              ) : (
                <ul className="space-y-2">
                  {riskFindings.map((f) => (
                    <li key={f.id} className="flex items-start justify-between gap-2 text-sm">
                      <span className="text-slate-700">{f.title}</span>
                      <span
                        className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium ${
                          f.severity === "high" || f.severity === "critical"
                            ? "bg-rose-50 text-rose-700"
                            : f.severity === "medium"
                              ? "bg-amber-50 text-amber-700"
                              : "bg-emerald-50 text-emerald-700"
                        }`}
                      >
                        {f.severity}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        )}

        {/* Action Plan + Impact/Effort */}
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Prioritized Action Plan</h2>
          <div className="grid gap-4 lg:grid-cols-[280px_1fr]">
            <div className="rounded-lg border border-slate-200 bg-white p-4">
              <p className="mb-2 text-xs font-medium text-slate-500">Impact vs. Effort</p>
              <svg viewBox="0 0 100 100" className="w-full">
                <line x1="50" y1="0" x2="50" y2="100" stroke="#e2e8f0" strokeWidth="0.5" />
                <line x1="0" y1="50" x2="100" y2="50" stroke="#e2e8f0" strokeWidth="0.5" />
                <text x="2" y="8" fontSize="4" fill="#94a3b8">High Impact</text>
                <text x="2" y="97" fontSize="4" fill="#94a3b8">Low Impact</text>
                <text x="65" y="97" fontSize="4" fill="#94a3b8">High Effort</text>
                {actionPlan.slice(0, 30).map((f, i) => {
                  const impact = impactOf(f.severity);
                  const effort = effortOf(f.effortBucket);
                  const color = impact === "High" && effort !== "High" ? "#059669" : impact === "High" ? "#d97706" : "#94a3b8";
                  return <circle key={f.id} cx={effortX(effort) + ((i % 3) - 1) * 2} cy={impactY(impact) + (Math.floor(i / 3) % 3) * 3} r="2.2" fill={color} opacity="0.85" />;
                })}
              </svg>
            </div>

            <div className="rounded-lg border border-slate-200 bg-white p-2">
              {actionPlan.length === 0 && <p className="p-4 text-sm text-slate-500">No findings to prioritize — clean crawl.</p>}
              <ul className="divide-y divide-slate-100">
                {actionPlan.map((f) => {
                  const priority = PRIORITY_BY_SEVERITY[f.severity] ?? "medium";
                  const impact = impactOf(f.severity);
                  const effort = effortOf(f.effortBucket);
                  const priorityColor =
                    priority === "high" ? "bg-rose-50 text-rose-700 border-rose-200" : priority === "medium" ? "bg-amber-50 text-amber-700 border-amber-200" : "bg-emerald-50 text-emerald-700 border-emerald-200";
                  return (
                    <li key={f.id} className="flex flex-wrap items-start gap-2 p-3">
                      <span className={`rounded-full border px-2 py-0.5 text-[10px] font-medium capitalize ${priorityColor}`}>{priority}</span>
                      <span className="rounded-full border border-slate-200 px-2 py-0.5 text-[10px] font-medium text-slate-600">
                        {AREA_BY_FINDING_TYPE[f.findingType] ?? "General"}
                      </span>
                      <span className="flex-1 text-sm text-slate-700">{f.title}.</span>
                      <span className="text-[10px] text-slate-400">
                        {EFFORT_LABEL[f.effortBucket] ?? "Effort"} · Impact: {impact} · Effort: {effort}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

function CoverageCard({ label, value, tone }: { label: string; value: number | string; tone?: "ok" | "warn" }) {
  const toneClasses = tone === "warn" ? "text-amber-700" : tone === "ok" ? "text-emerald-700" : "text-slate-900";
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className={`text-2xl font-semibold ${toneClasses}`}>{value}</div>
      <div className="mt-1 text-xs text-slate-500">{label}</div>
    </div>
  );
}

function ScoreTile({ label, value, subtitle }: { label: string; value: number; subtitle: string }) {
  const t = tierClasses(value);
  return (
    <div className={`rounded-lg border p-4 text-center ${t.bg} ${t.border}`}>
      <div className={`text-3xl font-semibold ${t.text}`}>{value}</div>
      <div className="mt-1 text-xs font-medium text-slate-700">{label}</div>
      <div className="mt-0.5 text-[10px] text-slate-500">{subtitle}</div>
    </div>
  );
}
