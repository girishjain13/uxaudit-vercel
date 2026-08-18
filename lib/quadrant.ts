/**
 * Impact x Effort 2x2 — richer than our flat severity+effortBucket
 * fields, matching the classic BA prioritization quadrant: Quick Wins
 * (High Impact/Low Effort), Major Projects (High/High), Fill-ins
 * (Low/Low), Time Sinks (Low Impact/High Effort).
 *
 * Impact derives from severity; Effort derives from effortBucket — both
 * fields already exist on every finding, so this is a relabeling, not
 * new detection logic.
 */
import type { findings } from "./db/schema";

type Finding = typeof findings.$inferSelect;

export type Quadrant = "Quick Win" | "Major Project" | "Fill-in" | "Time Sink";

export function impactOf(severity: string): "High" | "Low" {
  return severity === "critical" || severity === "high" ? "High" : "Low";
}

export function effortOf(effortBucket: string): "High" | "Low" {
  return effortBucket === "custom_dev" ? "High" : "Low";
}

export function quadrantOf(finding: Pick<Finding, "severity" | "effortBucket">): Quadrant {
  const impact = impactOf(finding.severity);
  const effort = effortOf(finding.effortBucket);
  if (impact === "High" && effort === "Low") return "Quick Win";
  if (impact === "High" && effort === "High") return "Major Project";
  if (impact === "Low" && effort === "Low") return "Fill-in";
  return "Time Sink";
}
