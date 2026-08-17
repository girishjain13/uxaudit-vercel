import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { audits, findings, pages } from "@/lib/db/schema";

export async function GET(req: NextRequest, { params }: { params: Promise<{ auditId: string }> }) {
  const { auditId } = await params;

  const audit = await db.query.audits.findFirst({ where: eq(audits.id, auditId) });
  if (!audit) {
    return NextResponse.json({ error: "audit not found" }, { status: 404 });
  }

  // Lightweight counts for a polling UI — not the full dataset, just
  // enough to show live progress without shipping every page row on
  // every poll.
  const [{ count: pageCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(pages)
    .where(eq(pages.auditId, auditId));

  const [{ count: findingCount }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(findings)
    .where(eq(findings.auditId, auditId));

  return NextResponse.json({
    id: audit.id,
    clientName: audit.clientName,
    startUrl: audit.startUrl,
    status: audit.status,
    createdAt: audit.createdAt,
    startedAt: audit.startedAt,
    finishedAt: audit.finishedAt,
    errorMessage: audit.errorMessage,
    pageCount,
    findingCount,
  });
}
