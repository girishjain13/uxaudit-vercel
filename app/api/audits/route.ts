import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/lib/db";
import { audits } from "@/lib/db/schema";
import { enqueuePageCrawl } from "@/lib/qstash";
import { incrOutstanding, markSeenIfNew, reserveEnqueueSlots } from "@/lib/redis";
import { discoverSitemapUrls } from "@/lib/sitemap";

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

  // Seed the queue with the start URL at depth 0. maxPages now actually
  // means something: every enqueue — this one included — reserves a
  // slot against the audit's budget first, so the total can never
  // exceed what was asked for, regardless of how many links or sitemap
  // entries get discovered along the way.
  await markSeenIfNew(audit.id, input.startUrl);
  const seedGranted = await reserveEnqueueSlots(audit.id, input.maxPages, 1);
  if (seedGranted > 0) {
    await incrOutstanding(audit.id, 1);
    await enqueuePageCrawl({
      auditId: audit.id,
      url: input.startUrl,
      depth: 0,
      maxConcurrency: input.maxConcurrency,
    });
  }

  // Sitemap seeding: link-following alone routinely under-discovers
  // pages on sites with JS pagination, mega-menus, or "load more"
  // patterns that don't expose every path in a single render. Pages
  // found only this way (never linked to internally) will correctly
  // still surface as orphan-page findings later — that's accurate
  // signal, not a bug, since they genuinely aren't reachable through
  // normal site navigation even though they exist.
  const sitemapUrls = await discoverSitemapUrls(input.startUrl);
  const newSitemapUrls: string[] = [];
  for (const url of sitemapUrls) {
    if (url === input.startUrl) continue;
    if (await markSeenIfNew(audit.id, url)) newSitemapUrls.push(url);
  }
  if (newSitemapUrls.length > 0) {
    const granted = await reserveEnqueueSlots(audit.id, input.maxPages, newSitemapUrls.length);
    const toEnqueue = newSitemapUrls.slice(0, granted);
    if (toEnqueue.length > 0) {
      await incrOutstanding(audit.id, toEnqueue.length);
      for (const url of toEnqueue) {
        await enqueuePageCrawl({ auditId: audit.id, url, depth: 1, maxConcurrency: input.maxConcurrency });
      }
    }
  }

  return NextResponse.json({ auditId: audit.id, status: audit.status }, { status: 201 });
}

export async function GET(req: NextRequest) {
  const all = await db.select().from(audits).orderBy(audits.createdAt);
  return NextResponse.json(all);
}
