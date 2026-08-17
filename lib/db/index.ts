import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

// neon-http (not the websocket/pool driver) is deliberate: each serverless
// function invocation is short-lived and stateless, so a per-request HTTP
// query fits better than maintaining a pooled connection that a function
// can't keep warm between invocations anyway.
//
// Constructed lazily, on first use, rather than at module load. Next.js's
// build-time "collecting page data" step imports every route module to
// inspect it — including this one, transitively — even for routes that
// never actually run in that phase. Building the Neon client eagerly at
// import time meant a missing/misconfigured DATABASE_URL crashed the
// *build*, not just a request that actually needed the database.
type Db = ReturnType<typeof drizzle<typeof schema>>;

let _db: Db | null = null;

function getDb(): Db {
  if (_db) return _db;
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set. Add it in Vercel's Project Settings → Environment Variables " +
        "(Production, Preview, and Development), or in .env.local for local dev.",
    );
  }
  const sql = neon(process.env.DATABASE_URL);
  _db = drizzle(sql, { schema });
  return _db;
}

// Proxy so existing call sites (`db.select()...`, `db.query.audits...`)
// keep working unchanged, fully typed — the lazy init happens transparently
// on first property access, not on import.
export const db: Db = new Proxy({} as Db, {
  get(_target, prop, receiver) {
    return Reflect.get(getDb() as object, prop, receiver);
  },
});
