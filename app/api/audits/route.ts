import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { audits } from "@/lib/db/schema";
import { enqueuePageCrawl } from "@/lib/qstash";
import { incrOutstanding, markSeenIfNew } from "@/lib/redis";

const createAuditSchema = z.object({
  clientName: z.string().min(1).max(200),
  startUrl: z.string().url(),
  maxPages: z.number().int().positive().max(20_000).default(500),
  maxDepth: z.number().int().positive().max(50).default(10),
  respectRobots: z.boolean().default(true),
  clientStatedPageCount: z.number().int().positive().optional(),
  maxConcurrency: z.number().int().positive().max(20).default(4),
  selectedPersonas: z.array(z.enum(["ux", "content", "business"])).min(1).default(["ux", "content", "business"]),
});

export async function POST(req: NextRequest) {
  const body = await req.json();
  const parsed = createAuditSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  }
  const input = parsed.data;

  const [audit] = await db
    .insert(audits)
    .values({
      clientName: input.clientName,
      startUrl: input.startUrl,
      maxPages: input.maxPages,
      maxDepth: input.maxDepth,
      respectRobots: input.respectRobots,
      clientStatedPageCount: input.clientStatedPageCount,
      selectedPersonas: input.selectedPersonas,
      status: "crawling",
      startedAt: new Date(),
      outstandingPageCount: 1,
    })
    .returning();

  // Seed the queue with exactly one job — the start URL at depth 0.
  // Everything after this is discovered and enqueued by /api/crawl/page
  // itself, page by page, the same way the original orchestrator grew
  // its frontier as it went — just without a loop holding it all in memory.
  await markSeenIfNew(audit.id, input.startUrl);
  await incrOutstanding(audit.id, 1);
  await enqueuePageCrawl({
    auditId: audit.id,
    url: input.startUrl,
    depth: 0,
    maxConcurrency: input.maxConcurrency,
  });

  return NextResponse.json({ auditId: audit.id, status: audit.status }, { status: 201 });
}

export async function GET(req: NextRequest) {
  const all = await db.select().from(audits).orderBy(audits.createdAt);
  return NextResponse.json(all);
}
