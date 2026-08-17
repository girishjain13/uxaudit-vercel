import { Client } from "@upstash/qstash";

export const qstash = new Client({ token: process.env.QSTASH_TOKEN! });

/**
 * Publish one "crawl this page" job. This is the direct replacement for
 * the original orchestrator's `audit.frontier.append({url, depth})` — the
 * frontier now IS the queue, not a JSON column polled by a loop.
 *
 * `dedup` (deduplicationId) + a per-audit `flowControlKey` give us, for
 * free, what the original did with asyncio.Semaphore(concurrency): bound
 * how many pages of a given audit render at once, so we don't hammer the
 * client's site or exceed Browserless's concurrent-session cap.
 */
export async function enqueuePageCrawl(params: {
  auditId: string;
  url: string;
  depth: number;
  maxConcurrency?: number;
}) {
  const { auditId, url, depth, maxConcurrency = 4 } = params;
  return qstash.publishJSON({
    url: `${process.env.APP_BASE_URL}/api/crawl/page`,
    body: { auditId, url, depth },
    // Per-audit concurrency cap — tune down for slower/smaller client sites,
    // up (within your Browserless plan's limits) for large audits.
    flowControl: { key: `audit:${auditId}`, parallelism: maxConcurrency },
    retries: 3,
  });
}

export async function enqueueAnalysis(auditId: string) {
  return qstash.publishJSON({
    url: `${process.env.APP_BASE_URL}/api/analyze/${auditId}`,
    body: { auditId },
    retries: 2,
  });
}
