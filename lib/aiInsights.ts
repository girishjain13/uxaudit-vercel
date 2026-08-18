/**
 * Port of the reference's ai_insights.py. Only runs if ANTHROPIC_API_KEY
 * is set — the rest of the audit (scores, action plan, all other
 * findings) works identically without it. Calls the API directly via
 * fetch (no SDK dependency needed for one call), same pattern as the
 * "AI-powered Artifacts" convention.
 */

export function aiInsightsAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

export async function generateAiSummary(input: {
  startUrl: string;
  pagesCrawled: number;
  scorecard: {
    iaHealthScore: number;
    contentQualityScore: number;
    accessibilityScore: number;
    seoScore: number;
    uxMaturityScore: number;
    uxMaturityBand: string;
  };
  orphanPageCount: number;
  maxClickDepth: number;
  thinContentCount: number;
  duplicateContentPageCount: number;
  pagesWithAccessibilityIssues: number;
  pagesAnalyzedForAccessibility: number;
  topIntegrations: string[];
  topActionItems: string[];
}): Promise<string | null> {
  if (!aiInsightsAvailable()) return null;

  const prompt = `You are a Senior UX Lead with 15+ years leading UX strategy for enterprise web
platforms, writing the executive summary section of a heuristic evaluation report for a
stakeholder audience (likely a VP of Product/Design or a client). Write with the voice of
someone who has run dozens of these and is being direct about what matters, not a generic
tool summarizing metrics back at the reader.

Structure your response in plain text (no markdown headers) as:
1. A 2-3 sentence overall read of where this site stands and why that matters for the business.
2. "Key risks" — the 2-3 findings most likely to cost the business something (conversions,
   compliance exposure, SEO visibility, or user trust) if left unaddressed, with a one-line
   rationale for each, not just a restated number.
3. "Recommended roadmap" — organize the fixes into Now (this sprint), Next (this quarter), and
   Later (backlog), with a one-line rationale per phase for why that sequencing makes sense.
Aim for substance over length, but don't artificially compress — 300-450 words is appropriate
for this audience.

Site: ${input.startUrl}
Pages crawled: ${input.pagesCrawled}
UX Maturity: ${input.scorecard.uxMaturityScore}/100 (${input.scorecard.uxMaturityBand})
IA Health: ${input.scorecard.iaHealthScore}/100 — Content Quality: ${input.scorecard.contentQualityScore}/100 — Accessibility: ${input.scorecard.accessibilityScore}/100 — SEO: ${input.scorecard.seoScore}/100
Orphan pages: ${input.orphanPageCount} — Max click depth: ${input.maxClickDepth}
Thin content pages: ${input.thinContentCount} — Duplicate content pages: ${input.duplicateContentPageCount}
Accessibility issues on: ${input.pagesWithAccessibilityIssues} of ${input.pagesAnalyzedForAccessibility} pages
Detected third-party integrations: ${input.topIntegrations.join(", ") || "none recognized"}
Top action items already identified: ${input.topActionItems.join("; ")}`;

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1200,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!res.ok) {
      console.error(`[aiInsights] Anthropic API returned ${res.status}: ${await res.text()}`);
      return null;
    }

    const data = (await res.json()) as { content?: { type: string; text?: string }[] };
    const text = data.content
      ?.filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("\n")
      .trim();
    return text || null;
  } catch (err) {
    console.error("[aiInsights] failed to generate AI summary:", err);
    return null; // AI summary is optional — never fail the whole analysis over this
  }
}
