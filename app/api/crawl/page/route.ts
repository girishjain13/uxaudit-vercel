import { verifySignatureAppRouter } from "@upstash/qstash/nextjs";
import { NextRequest, NextResponse } from "next/server";
import { put } from "@vercel/blob";
import { eq } from "drizzle-orm";
import { urlToNetloc } from "@/lib/url";
import { db } from "@/lib/db";
import { assets, audits, interactions, links, pages, screenshots } from "@/lib/db/schema";
import { renderPage } from "@/lib/browserless";
import { canFetch, loadRobots } from "@/lib/robots";
import { enqueueAnalysis, enqueuePageCrawl } from "@/lib/qstash";
import { decrOutstandingAndCheckDone, incrOutstanding, markSeenIfNew } from "@/lib/redis";

/**
 * This function is the per-page equivalent of the original orchestrator's
 * render_only() + persist_result() pair, combined into one step, because
 * there's no shared in-process session to split rendering (concurrent-safe)
 * from DB writes (sequential-only) across — each invocation IS one page,
 * handled start to finish, and QStash's flowControl parallelism setting is
 * what bounds how many of these run at once (replacing asyncio.Semaphore).
 */
async function handler(req: NextRequest) {
  const { auditId, url, depth } = (await req.json()) as {
    auditId: string;
    url: string;
    depth: number;
  };

  const audit = await db.query.audits.findFirst({ where: eq(audits.id, auditId) });
  if (!audit) {
    return NextResponse.json({ error: "audit not found" }, { status: 404 });
  }

  const rootHost = urlToNetloc(audit.startUrl);

  const robots = await loadRobots(auditId, audit.startUrl);
  if (audit.respectRobots && !canFetch(robots, url)) {
    await db.insert(pages).values({ auditId, url, depth, error: "blocked_by_robots_txt" });
    await finishAndMaybeAnalyze(auditId);
    return NextResponse.json({ ok: true, skipped: "robots" });
  }

  const result = await renderPage(url, rootHost);

  const [pageRow] = await db
    .insert(pages)
    .values({
      auditId,
      url: result.finalUrl,
      depth,
      statusCode: result.statusCode,
      responseTimeMs: result.responseTimeMs,
      htmlSource: result.htmlSource,
      renderedDomHtml: result.renderedDomHtml,
      isClientRendered: result.isClientRendered,
      title: result.title,
      metaDescription: result.metaDescription,
      h1Text: result.h1Text,
      canonical: result.canonical,
      wordCount: result.wordCount,
      lcpMs: result.lcpMs,
      clsScore: result.clsScore,
      inpMs: result.inpMs,
      error: result.error,
    })
    .returning();

  if (result.internalLinks.length || result.externalLinks.length) {
    await db.insert(links).values([
      ...result.internalLinks.map((target) => ({
        auditId,
        sourceUrl: result.finalUrl,
        targetUrl: target,
        isInternal: true,
      })),
      ...result.externalLinks.map((target) => ({
        auditId,
        sourceUrl: result.finalUrl,
        targetUrl: target,
        isInternal: false,
      })),
    ]);
  }

  const assetRows = [
    ...result.images.map((u) => ({ pageId: pageRow.id, assetType: "image", url: u, domain: urlToNetloc(u) })),
    ...result.videos.map((u) => ({ pageId: pageRow.id, assetType: "video", url: u, domain: urlToNetloc(u) })),
    ...result.documents.map((u) => ({ pageId: pageRow.id, assetType: "document", url: u, domain: urlToNetloc(u) })),
  ];
  if (assetRows.length) await db.insert(assets).values(assetRows as any);

  if (result.interactions.length) {
    await db.insert(interactions).values(
      result.interactions.map((i) => ({
        pageId: pageRow.id,
        interactionType: i.type,
        selectorSignature: i.selector,
      })),
    );
  }

  // Screenshots go to Vercel Blob, not local disk — the original wrote
  // PNGs under screenshots/{audit_id}/{page_id}_{breakpoint}.png on a
  // volume that survives container restarts; a serverless function has
  // no equivalent, so the durable copy is Blob and the DB row stores its URL.
  for (const [bp, buf] of Object.entries(result.screenshots)) {
    if (!buf.length) continue;
    const blob = await put(`screenshots/${auditId}/${pageRow.id}_${bp}.png`, buf, {
      access: "public",
      contentType: "image/png",
    });
    const flags = result.screenshotFlags[bp] ?? { hasHorizontalScroll: false, hasSmallTapTargets: false };
    await db.insert(screenshots).values({
      pageId: pageRow.id,
      breakpoint: bp,
      viewportWidth: { mobile: 375, tablet: 768, desktop: 1440 }[bp as "mobile" | "tablet" | "desktop"],
      blobUrl: blob.url,
      hasHorizontalScroll: flags.hasHorizontalScroll,
      hasOverlapSuspected: flags.hasSmallTapTargets,
    });
  }

  // Discover further pages — same depth/max_pages guard as the original,
  // just with Redis SETNX instead of an in-memory list for dedup, since
  // multiple invocations can race on the same discovered link.
  if (depth < audit.maxDepth) {
    for (const link of result.internalLinks) {
      const isNew = await markSeenIfNew(auditId, link);
      if (isNew) {
        await incrOutstanding(auditId, 1);
        await enqueuePageCrawl({ auditId, url: link, depth: depth + 1 });
      }
    }
  }

  await finishAndMaybeAnalyze(auditId);
  return NextResponse.json({ ok: true, pageId: pageRow.id });
}

async function finishAndMaybeAnalyze(auditId: string) {
  const isDone = await decrOutstandingAndCheckDone(auditId);
  if (isDone) {
    await db.update(audits).set({ status: "analyzing" }).where(eq(audits.id, auditId));
    await enqueueAnalysis(auditId);
  }
}

// Verifies the request actually came from QStash (signed), not an
// arbitrary POST — important since this endpoint writes to the DB and
// spends Browserless credits per call.
//
// verifySignatureAppRouter(handler) validates QSTASH_CURRENT_SIGNING_KEY /
// QSTASH_NEXT_SIGNING_KEY the moment it's called — calling it directly at
// module scope (`export const POST = verifySignatureAppRouter(handler)`)
// meant Next.js's build-time page-data collection crashed on missing keys
// before a single request ever came in. Wrapping happens inside POST
// itself instead, so it only runs (and only needs those env vars) once an
// actual request arrives.
export async function POST(req: NextRequest) {
  const verified = verifySignatureAppRouter(handler);
  return verified(req);
}
