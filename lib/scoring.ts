/**
 * Direct port of the reference tool's analyzers/scoring.py: simple,
 * transparent percentage-based scores (0 bad -> 100, all bad -> 0),
 * not a black-box model. Weights are intentionally simple so they can
 * be tuned per engagement, same rationale as the source.
 */

function pctScore(bad: number, total: number): number {
  if (total <= 0) return 100;
  return Math.round(100 * (1 - bad / total) * 10) / 10;
}

export type ScoreInputs = {
  totalPages: number;
  orphanPageCount: number;
  pagesOverThreeClicks: number;
  thinContentCount: number;
  duplicateContentPageCount: number;
  missingH1Count: number;
  imageAltCoveragePct: number; // 0-100
  pagesWithAccessibilityIssues: number;
  missingTitleCount: number;
  missingMetaDescriptionCount: number;
  canonicalMissingCount: number;
};

export type Scorecard = {
  iaHealthScore: number;
  contentQualityScore: number;
  accessibilityScore: number;
  seoScore: number;
  uxMaturityScore: number;
  uxMaturityBand: "Strong" | "Adequate" | "Needs Improvement" | "Critical";
};

export function scoreIa(inputs: ScoreInputs): number {
  const total = Math.max(inputs.totalPages, 1);
  const orphanScore = pctScore(inputs.orphanPageCount, total);
  const depthScore = pctScore(inputs.pagesOverThreeClicks, total);
  return Math.round((orphanScore * 0.5 + depthScore * 0.5) * 10) / 10;
}

export function scoreContent(inputs: ScoreInputs): number {
  const total = Math.max(inputs.totalPages, 1);
  const thinScore = pctScore(inputs.thinContentCount, total);
  const dupScore = pctScore(inputs.duplicateContentPageCount, total);
  const headingScore = pctScore(inputs.missingH1Count, total);
  const altScore = inputs.imageAltCoveragePct;
  return Math.round((thinScore * 0.25 + dupScore * 0.25 + headingScore * 0.25 + altScore * 0.25) * 10) / 10;
}

export function scoreAccessibility(inputs: ScoreInputs): number {
  return pctScore(inputs.pagesWithAccessibilityIssues, Math.max(inputs.totalPages, 1));
}

export function scoreSeo(inputs: ScoreInputs): number {
  const total = Math.max(inputs.totalPages, 1);
  const titleScore = pctScore(inputs.missingTitleCount, total);
  const descScore = pctScore(inputs.missingMetaDescriptionCount, total);
  const canonicalScore = pctScore(inputs.canonicalMissingCount, total);
  return Math.round((titleScore * 0.4 + descScore * 0.4 + canonicalScore * 0.2) * 10) / 10;
}

function band(score: number): Scorecard["uxMaturityBand"] {
  if (score >= 85) return "Strong";
  if (score >= 70) return "Adequate";
  if (score >= 50) return "Needs Improvement";
  return "Critical";
}

export function buildScorecard(inputs: ScoreInputs): Scorecard {
  const iaHealthScore = scoreIa(inputs);
  const contentQualityScore = scoreContent(inputs);
  const accessibilityScore = scoreAccessibility(inputs);
  const seoScore = scoreSeo(inputs);
  const uxMaturityScore =
    Math.round(((iaHealthScore + contentQualityScore + accessibilityScore + seoScore) / 4) * 10) / 10;

  return {
    iaHealthScore,
    contentQualityScore,
    accessibilityScore,
    seoScore,
    uxMaturityScore,
    uxMaturityBand: band(uxMaturityScore),
  };
}
