import { and, asc, eq, gt } from "drizzle-orm";
import { db } from "./index";
import { pages } from "./schema";

/**
 * Root cause of the "response is too large (max is 67108864 bytes)"
 * error: Neon's serverless HTTP driver returns an entire query result in
 * one HTTP response, capped at 64MB. `db.select().from(pages)` pulls
 * every column — including `htmlSource`, which is dead weight (see
 * comment below) — for every page in the audit in a single round trip.
 * Once a crawl covers enough pages, that single response blows past the
 * cap, and it gets worse the larger the audit, with no ceiling in code
 * to prevent it.
 *
 * Two fixes combined here:
 * 1. Column pruning — `htmlSource` is never read anywhere outside the
 *    insert in app/api/crawl/page/route.ts, and lib/browserless.ts sets
 *    it to the exact same value as `renderedDomHtml` on every single
 *    page (`htmlSource: renderedDomHtml`). It's a byte-for-byte
 *    duplicate stored and fetched for zero benefit — excluding it here
 *    roughly halves the payload immediately.
 * 2. Pagination — fetching in bounded batches (ordered by primary key,
 *    keyset pagination rather than OFFSET, so it stays fast as an audit
 *    grows) means no single Neon round trip can ever approach the cap,
 *    regardless of how many pages an audit eventually covers. Results
 *    accumulate in this function's local memory across batches, which
 *    has nothing to do with Neon's per-response limit — only the size
 *    of each individual HTTP round trip matters here.
 */
export type PageForAnalysis = Omit<typeof pages.$inferSelect, "htmlSource">;

export async function fetchAllPagesForAnalysis(auditId: string, batchSize = 100): Promise<PageForAnalysis[]> {
  const results: PageForAnalysis[] = [];
  let cursor = "";

  // Keyset pagination on `id` (a UUID, so plain string comparison for
  // ordering is fine — we only need a stable, monotonic-enough cursor to
  // avoid re-fetching or skipping rows, not a meaningful sort order).
  for (;;) {
    const batch = await db
      .select({
        id: pages.id,
        auditId: pages.auditId,
        url: pages.url,
        statusCode: pages.statusCode,
        responseTimeMs: pages.responseTimeMs,
        depth: pages.depth,
        templateFingerprint: pages.templateFingerprint,
        contentTypeLabel: pages.contentTypeLabel,
        renderedDomHtml: pages.renderedDomHtml,
        isClientRendered: pages.isClientRendered,
        title: pages.title,
        metaDescription: pages.metaDescription,
        h1Text: pages.h1Text,
        canonical: pages.canonical,
        wordCount: pages.wordCount,
        textHash: pages.textHash,
        readabilityScore: pages.readabilityScore,
        lastModified: pages.lastModified,
        lcpMs: pages.lcpMs,
        clsScore: pages.clsScore,
        inpMs: pages.inpMs,
        accessibilityViolations: pages.accessibilityViolations,
        error: pages.error,
      })
      .from(pages)
      .where(cursor ? and(eq(pages.auditId, auditId), gt(pages.id, cursor)) : eq(pages.auditId, auditId))
      .orderBy(asc(pages.id))
      .limit(batchSize);

    if (batch.length === 0) break;
    results.push(...batch);
    cursor = batch[batch.length - 1].id;
    if (batch.length < batchSize) break;
  }

  return results;
}
