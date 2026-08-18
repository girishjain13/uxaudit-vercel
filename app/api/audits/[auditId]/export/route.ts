import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import * as XLSX from "xlsx";
import { db } from "@/lib/db";
import { audits, findings, pages } from "@/lib/db/schema";

/**
 * Generates the "exportable, filterable spreadsheet" deliverable the
 * original spec calls for per persona — this single export covers all
 * three (Findings carries the `personas` tag per row, so a Content
 * Strategist or Business Analyst can filter to their own rows in Excel
 * rather than needing three separate export endpoints).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ auditId: string }> }) {
  const { auditId } = await params;

  const audit = await db.query.audits.findFirst({ where: eq(audits.id, auditId) });
  if (!audit) {
    return NextResponse.json({ error: "audit not found" }, { status: 404 });
  }

  const allFindings = await db.select().from(findings).where(eq(findings.auditId, auditId));
  const allPages = await db.select().from(pages).where(eq(pages.auditId, auditId));

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

  const pagesSheet = XLSX.utils.json_to_sheet(
    allPages.map((p) => ({
      URL: p.url,
      "Status Code": p.statusCode,
      "Response Time (ms)": p.responseTimeMs,
      Title: p.title,
      "Meta Description": p.metaDescription,
      H1: p.h1Text,
      "Word Count": p.wordCount,
      "Client Rendered": p.isClientRendered,
      Error: p.error,
    })),
  );

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, findingsSheet, "Findings");
  XLSX.utils.book_append_sheet(workbook, pagesSheet, "Pages");

  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });

  const filename = `${audit.clientName.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}-audit.xlsx`;

  return new NextResponse(buffer, {
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
