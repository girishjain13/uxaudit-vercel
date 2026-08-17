import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import * as schema from "./schema";

// neon-http (not the websocket/pool driver) is deliberate: each serverless
// function invocation is short-lived and stateless, so a per-request HTTP
// query fits better than maintaining a pooled connection that a function
// can't keep warm between invocations anyway.
const sql = neon(process.env.DATABASE_URL!);
export const db = drizzle(sql, { schema });
