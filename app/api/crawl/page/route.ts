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
import { decrOutstandingAndCheckDone, incrOutstanding, markSeenIfNew, reserveEnqueueSlots } from "@/lib/redis";

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

  try {
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
        lastModified: result.lastModified,
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
        accessibilityViolations: result.accessibilityViolations,
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
    if (!process.env.BLOB_READ_WRITE_TOKEN) {
      // A generic "no token found" error gives no way to tell WHICH
      // Vercel project actually ran this — and this codebase has been
      // deployed under more than one project slug over the course of
      // setup. Surfacing VERCEL_URL/VERCEL_PROJECT_PRODUCTION_URL here
      // turns "it's still broken" into "here's the exact project that
      // still needs Blob connected," rather than another round of
      // re-checking the same (possibly wrong) project's settings.
      throw new Error(
        `BLOB_READ_WRITE_TOKEN is not set on this deployment. ` +
          `VERCEL_PROJECT_PRODUCTION_URL=${process.env.VERCEL_PROJECT_PRODUCTION_URL ?? "unknown"} ` +
          `VERCEL_URL=${process.env.VERCEL_URL ?? "unknown"} ` +
          `VERCEL_ENV=${process.env.VERCEL_ENV ?? "unknown"}. ` +
          `Go to Vercel → this exact project → Storage → connect/create a Blob store, then redeploy.`,
      );
    }
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

    // Discover further pages. Previously this only checked depth —
    // despite the comment here once claiming a maxPages guard existed,
    // nothing ever actually capped the total page count. reserveEnqueueSlots
    // (lib/redis.ts) now enforces the real budget across both this
    // link-discovery path and the sitemap-seeding path in
    // app/api/audits/route.ts, atomically, so concurrent page-crawl
    // invocations can't collectively overshoot it.
    if (depth < audit.maxDepth) {
      const newlyDiscovered: string[] = [];
      for (const link of result.internalLinks) {
        if (await markSeenIfNew(auditId, link)) newlyDiscovered.push(link);
      }
      if (newlyDiscovered.length > 0) {
        const granted = await reserveEnqueueSlots(auditId, audit.maxPages, newlyDiscovered.length);
        const toEnqueue = newlyDiscovered.slice(0, granted);
        if (toEnqueue.length > 0) {
          await incrOutstanding(auditId, toEnqueue.length);
          for (const link of toEnqueue) {
            await enqueuePageCrawl({ auditId, url: link, depth: depth + 1 });
          }
        }
      }
    }

    await finishAndMaybeAnalyze(auditId);
    return NextResponse.json({ ok: true, pageId: pageRow.id });
  } catch (err) {
    // Without this, a thrown error (e.g. Browserless unreachable/misconfigured,
    // a bad response, a DB write failure) would abort the function before
    // finishAndMaybeAnalyze ever ran — leaving the audit's outstanding
    // counter permanently non-zero and its status stuck at "crawling"
    // forever, with no page ever recorded and no visible error. Every
    // failure now gets logged, recorded on the page/audit rows, and still
    // decrements the counter so the audit can reach a terminal state.
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[crawl/page] audit=${auditId} url=${url} depth=${depth}:`, err);

    try {
      await db.insert(pages).values({ auditId, url, depth, error: message.slice(0, 2000) });
    } catch {
      // best-effort — don't let a failed error-log write mask the real error
    }

    if (depth === 0) {
      // The seed page itself failed: nothing else will ever get enqueued
      // for this audit, so end it now as a clear failure rather than
      // leaving it stuck, or letting it silently reach "done" with zero
      // pages once the counter hits zero.
      await db
        .update(audits)
        .set({ status: "failed", errorMessage: message, finishedAt: new Date() })
        .where(eq(audits.id, auditId));
    } else {
      const isDone = await decrOutstandingAndCheckDone(auditId);
      await db.update(audits).set({ errorMessage: message }).where(eq(audits.id, auditId));
      if (isDone) {
        await db.update(audits).set({ status: "analyzing" }).where(eq(audits.id, auditId));
        await enqueueAnalysis(auditId);
      }
    }

    // Returns 200 deliberately: the failure is already recorded and the
    // counter already adjusted, so letting QStash retry this same message
    // would double-decrement the counter and could flip the audit to
    // "done"/"analyzing" prematurely.
    return NextResponse.json({ ok: false, error: message });
  }
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
