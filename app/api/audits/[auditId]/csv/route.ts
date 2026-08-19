import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { audits, findings } from "@/lib/db/schema";

function csvEscape(value: unknown): string {
  const str = value == null ? "" : String(value);
  if (/[",\n]/.test(str)) return `"${str.replace(/"/g, '""')}"`;
  return str;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ auditId: string }> }) {
  const { auditId } = await params;

  const audit = await db.query.audits.findFirst({ where: eq(audits.id, auditId) });
  if (!audit) return NextResponse.json({ error: "audit not found" }, { status: 404 });

  const allFindingsUnfiltered = await db.select().from(findings).where(eq(findings.auditId, auditId));
  const selectedPersonas = new Set(audit.selectedPersonas ?? ["ux", "content", "business"]);
  const allFindings = allFindingsUnfiltered.filter(
    (f) => f.findingType === "scale_summary" || f.personas.some((p) => selectedPersonas.has(p)),
  );

  const headers = ["Type", "Title", "Severity", "Effort Bucket", "Personas", "Affected Pages", "Description", "Detection Method"];
  const rows = allFindings.map((f) =>
    [f.findingType, f.title, f.severity, f.effortBucket, f.personas.join("|"), f.affectedPageCount, f.description, f.detectionMethod]
      .map(csvEscape)
      .join(","),
  );
  const csv = [headers.join(","), ...rows].join("\n");

  const filename = `${audit.clientName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-findings.csv`;
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
