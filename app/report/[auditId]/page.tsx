import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { db } from "@/lib/db";
import { audits, findings, links, pages } from "@/lib/db/schema";
import { countImagesAndMissingAlt } from "@/lib/reportAnalysis";
import { buildScorecard } from "@/lib/scoring";
import { fetchAllPagesForAnalysis } from "@/lib/db/pagesBatch";

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

export default async function ReportPage({ params }: { params: Promise<{ auditId: string }> }) {
  const { auditId } = await params;

  const audit = await db.query.audits.findFirst({ where: eq(audits.id, auditId) });
  if (!audit) notFound();

  const allPages = await fetchAllPagesForAnalysis(auditId);
  const allFindings = await db.select().from(findings).where(eq(findings.auditId, auditId));
  const allLinks = await db.select().from(links).where(eq(links.auditId, auditId));

  // --- Scorecard inputs, derived from the same data the Excel export uses ---
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
  const pagesWithA11yIssues = new Set(allPages.filter((p) => (p.accessibilityViolations ?? []).length > 0)).size;

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
    pagesWithAccessibilityIssues: pagesWithA11yIssues,
    missingTitleCount: findingByType("missing_title")?.affectedPageCount ?? 0,
    missingMetaDescriptionCount: findingByType("missing_meta_description")?.affectedPageCount ?? 0,
    canonicalMissingCount: allPages.filter((p) => !p.canonical).length,
  });

  const actionPlan = [...allFindings]
    .filter((f) => f.findingType !== "scale_summary")
    .sort((a, b) => {
      const rank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
      return (rank[a.severity] ?? 4) - (rank[b.severity] ?? 4);
    });

  const heuristics = buildHeuristicCards(allFindings);

  const internalLinksOutByUrl = new Map<string, number>();
  for (const link of allLinks) {
    if (link.isInternal) internalLinksOutByUrl.set(link.sourceUrl, (internalLinksOutByUrl.get(link.sourceUrl) ?? 0) + 1);
  }

  return (
    <>
      <div className="masthead">
        <div className="kicker">Audit Report</div>
        <h1>{audit.startUrl}</h1>
        <div className="sub">
          {audit.clientName} — crawled {allPages.length} page(s), {allFindings.length} finding(s)
          {audit.finishedAt ? ` — finished ${new Date(audit.finishedAt).toLocaleString()}` : ""}
        </div>
      </div>

      <div className="wrap">
        <div className="section">
          <div className="section-head">
            <h2>Audit Coverage</h2>
          </div>
          <div className="stat-row" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
            <div className="stat">
              <div className="v">{allPages.length}</div>
              <div className="l">Pages crawled</div>
            </div>
            <div className="stat">
              <div className="v">{allFindings.length}</div>
              <div className="l">Findings</div>
            </div>
            <div className="stat">
              <div className="v">{allPages.filter((p) => p.error).length}</div>
              <div className="l">Errors / blocked</div>
            </div>
          </div>
        </div>

        <div className="section">
          <div className="section-head">
            <h2>Scorecard</h2>
            <div className="desc">
              Simple, transparent percentage scores — 0 issues found scores 100, every page affected scores 0. Not a
              black-box model; weights are documented in <code>lib/scoring.ts</code>.
            </div>
          </div>
          <div className="score-grid">
            <ScoreCard label="IA Health" value={scorecard.iaHealthScore} />
            <ScoreCard label="Content Quality" value={scorecard.contentQualityScore} />
            <ScoreCard label="Accessibility" value={scorecard.accessibilityScore} />
            <ScoreCard label="SEO" value={scorecard.seoScore} />
            <ScoreCard label="UX Maturity" value={scorecard.uxMaturityScore} plain={scorecard.uxMaturityBand} />
          </div>
        </div>

        <div className="section">
          <div className="section-head">
            <h2>Heuristic Evaluation</h2>
            <div className="desc">
              Nielsen's 10 usability heuristics, mapped against what a static crawl can actually detect. Most
              require watching real interactions or reading for tone — flagged honestly as not assessed rather than
              guessed at.
            </div>
          </div>
          <div className="heuristic-grid">
            {heuristics.map((h) => (
              <div key={h.name} className={`heuristic-card ${h.assessed ? "" : "not-assessed"}`}>
                <div className="htop">
                  <h3>{h.name}</h3>
                  <span className={`sev-badge ${h.assessed ? `sev-${h.severity}` : "na"}`}>
                    {h.assessed ? h.severity : "N/A"}
                  </span>
                </div>
                <div className="blurb">{h.topFinding}</div>
                {!h.assessed && <div className="blurb" style={{ fontStyle: "italic", marginTop: 6 }}>{h.whyNot}</div>}
              </div>
            ))}
          </div>
        </div>

        <div className="section">
          <div className="section-head">
            <h2>Prioritized Action Plan</h2>
          </div>
          <div className="card">
            {actionPlan.length === 0 && <p className="small-dim">No findings to prioritize — clean crawl.</p>}
            {actionPlan.map((f) => (
              <div key={f.id} className="action-item">
                <span className={`pill ${PRIORITY_BY_SEVERITY[f.severity] ?? "medium"}`}>
                  {PRIORITY_BY_SEVERITY[f.severity] ?? "medium"}
                </span>
                <span className="action-area">{AREA_BY_FINDING_TYPE[f.findingType] ?? "General"}</span>
                <span>{f.title}.</span>
              </div>
            ))}
          </div>
        </div>

        <div className="section">
          <div className="section-head">
            <h2>Full Page Inventory</h2>
          </div>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>URL</th>
                  <th>Status</th>
                  <th>Title</th>
                  <th>Words</th>
                  <th>Click Depth</th>
                  <th>Internal Links Out</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {allPages.map((p) => (
                  <tr key={p.id}>
                    <td className="url-cell">{p.url}</td>
                    <td>{p.statusCode ?? "—"}</td>
                    <td>{p.title ?? "—"}</td>
                    <td>{p.wordCount}</td>
                    <td>{p.depth}</td>
                    <td>{internalLinksOutByUrl.get(p.url) ?? 0}</td>
                    <td>
                      {p.error ? (
                        <span className="tag bad">{p.error.slice(0, 60)}</span>
                      ) : (
                        <span className="tag ok">ok</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="section">
          <div className="card">
            <a className="btn" href={`/api/audits/${auditId}/export`}>
              Download Excel report →
            </a>
          </div>
        </div>
      </div>
    </>
  );
}

function ScoreCard({ label, value, plain }: { label: string; value: number; plain?: string }) {
  const bandClass =
    value >= 85 ? "band-Strong" : value >= 70 ? "band-Adequate" : value >= 50 ? "band-Needs-Improvement" : "band-Critical";
  return (
    <div className={`score-card ${bandClass}`}>
      <div className="num">{value}</div>
      <div className="label">{label}</div>
      {plain && <div className="plain">{plain}</div>}
    </div>
  );
}

type Finding = typeof findings.$inferSelect;

/**
 * Same Nielsen-heuristic mapping used in the Excel export's Heuristic
 * Evaluation sheet, rendered as cards here instead of rows.
 */
function buildHeuristicCards(allFindings: Finding[]) {
  const duplicateTitle = allFindings.find((f) => f.findingType === "duplicate_title");
  const brokenLinks = allFindings.find((f) => f.findingType === "broken_page");

  return [
    { name: "H1 — Visibility of system status", assessed: false, severity: "low" as const, topFinding: "", whyNot: "Requires watching real interactions — a static crawl only sees returned HTML." },
    { name: "H2 — Match between system and the real world", assessed: false, severity: "low" as const, topFinding: "", whyNot: "A judgment call about wording — needs a human reader." },
    { name: "H3 — User control and freedom", assessed: false, severity: "low" as const, topFinding: "", whyNot: "Needs testing real flows (forms, checkout) — outside crawl scope." },
    {
      name: "H4 — Consistency and standards",
      assessed: Boolean(duplicateTitle),
      severity: (duplicateTitle?.severity ?? "low") as Finding["severity"],
      topFinding: duplicateTitle?.title ?? "No consistency issues detected.",
      whyNot: "",
    },
    { name: "H5 — Error prevention", assessed: false, severity: "low" as const, topFinding: "", whyNot: "Needs form-submission testing." },
    { name: "H6 — Recognition rather than recall", assessed: false, severity: "low" as const, topFinding: "", whyNot: "A judgment call about interface memory load." },
    { name: "H7 — Flexibility and efficiency of use", assessed: false, severity: "low" as const, topFinding: "", whyNot: "Requires testing with real users across skill levels." },
    { name: "H8 — Aesthetic and minimalist design", assessed: false, severity: "low" as const, topFinding: "", whyNot: "A visual/subjective judgment call." },
    {
      name: "H9 — Help users recognize, diagnose, and recover from errors",
      assessed: Boolean(brokenLinks),
      severity: (brokenLinks?.severity ?? "low") as Finding["severity"],
      topFinding: brokenLinks?.title ?? "No broken links detected.",
      whyNot: "",
    },
    { name: "H10 — Help and documentation", assessed: false, severity: "low" as const, topFinding: "", whyNot: "Requires reviewing help-content quality directly." },
  ];
}
