# Website Audit Crawler — Vercel-native rewrite

Event-driven reimplementation of the crawler from the original spec, restructured so
every step is a short serverless function instead of one long-running orchestrator loop.

## Why this shape

Vercel functions are request/response, time-limited, and stateless between invocations.
The original design (one async loop popping a frontier, running Playwright, writing to
Postgres) doesn't fit that model. This version turns "crawl the site" into "crawl one
page," repeated by a queue, with all state living in Postgres + Redis instead of in a
process's memory.

```
POST /api/audits
      │  create Audit row, publish 1 QStash message (start_url, depth 0)
      ▼
QStash queue (per-audit concurrency limit + retries)
      │
      ▼
POST /api/crawl/page   ◄── invoked by QStash, once per page
      │  1. robots.txt check (Upstash Redis cache)
      │  2. Browserless: render page, screenshot 3 breakpoints, extract links
      │  3. write Page / Link / Asset / Screenshot rows (Postgres via Drizzle)
      │  4. upload screenshots to Vercel Blob
      │  5. for each new internal link: Redis SETNX dedup → publish new QStash msg
      │  6. decrement/track audit's outstanding-page counter in Redis
      ▼
   counter hits 0
      │
      ▼
POST /api/analyze/{auditId}   ◄── one-shot rollup pass
      - template/pattern clustering, duplicate content, accessibility summary,
        tech fingerprinting, effort tagging, exec summary generation
      - writes Finding rows
```

## What's implemented in this scaffold vs. stubbed

Implemented (runnable shape, real logic):
- `lib/db/schema.ts` — full relational schema (parity with the original `schema.py`)
- `lib/qstash.ts` — publish/verify helpers
- `lib/redis.ts` — dedup + outstanding-page counter helpers
- `lib/browserless.ts` — remote render call (HTML, DOM, screenshots, links, basic CWV)
- `app/api/audits/route.ts` — create audit, seed the queue
- `app/api/crawl/page/route.ts` — the per-page worker (the core of the rewrite)
- `app/api/analyze/[auditId]/route.ts` — rollup entrypoint with the aggregation
  queries stubbed (this is where UX/Content/Business persona logic from the
  original spec's `app/analyzers/` — still empty in the original repo too — belongs)

Not implemented yet (same state as the original repo — these were never built there
either): axe-core accessibility scan, component/button-style clustering, duplicate
content similarity, readability scoring, tech fingerprinting, effort-bucket tagging,
XLSX/PDF export templates. The rollup route has clearly marked TODOs for each.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in Neon, Upstash, Browserless, Blob credentials
npx drizzle-kit push         # create tables in Neon
vercel dev                   # or `next dev` — QStash needs a public URL to call back,
                              # so use `vercel dev --listen` + a tunnel (ngrok/ Vercel's
                              # own dev tunnel) when testing the queue locally
```

## Environment variables

See `.env.example`. You'll need accounts for: Neon (Postgres), Upstash (QStash + Redis),
Browserless.io or Browserbase, and Vercel Blob (auto-provisioned if deployed on Vercel).

## Concurrency & rate limiting

QStash's per-URL rate limiting (`Upstash-Rate-Limit` / topic-based delay) stands in for
the original `asyncio.Semaphore(concurrency)`. Set this per audit domain to avoid both
hammering the client's site and exceeding your Browserless plan's concurrent session cap.

## Cost note

Each page-crawl invocation makes one Browserless render call. Browserless bills per
session/minute — for a 1,000-page audit with 3 screenshots each, budget accordingly
before running against a large client site.
