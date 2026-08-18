/**
 * Canonical schema — direct port of the original app/models/schema.py.
 * One normalized set of tables every persona view reads from; persona
 * relevance lives on `findings.personas` as a tag array, not as separate
 * schemas per persona. See the original file's docstring for the full
 * rationale — it carries over unchanged into this rewrite.
 */
import { relations } from "drizzle-orm";
import {
  boolean,
  doublePrecision,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const auditStatusEnum = pgEnum("audit_status", [
  "queued",
  "crawling",
  "analyzing",
  "done",
  "failed",
]);

export const effortBucketEnum = pgEnum("effort_bucket", [
  "ootb",
  "config",
  "custom_dev",
]);

export const severityEnum = pgEnum("severity", [
  "low",
  "medium",
  "high",
  "critical",
]);

export const audits = pgTable("audits", {
  id: uuid("id").primaryKey().defaultRandom(),
  clientName: varchar("client_name", { length: 200 }).notNull(),
  startUrl: varchar("start_url", { length: 2000 }).notNull(),
  status: auditStatusEnum("status").notNull().default("queued"),
  maxPages: integer("max_pages").notNull().default(500),
  maxDepth: integer("max_depth").notNull().default(10),
  respectRobots: boolean("respect_robots").notNull().default(true),
  clientStatedPageCount: integer("client_stated_page_count"),
  // Replaces the original's in-memory-frontier-as-JSON-column approach:
  // the frontier now lives in the QStash queue itself (each queued
  // message *is* a frontier entry), and "seen" tracking moves to Redis
  // SETNX for atomic dedup under concurrent invocations. This column is
  // kept only as a running total for progress display / completion
  // detection, not as the actual work queue.
  outstandingPageCount: integer("outstanding_page_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp("started_at", { withTimezone: true }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  errorMessage: text("error_message"),
});

export const pages = pgTable(
  "pages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    auditId: uuid("audit_id").notNull().references(() => audits.id, { onDelete: "cascade" }),
    url: varchar("url", { length: 2000 }).notNull(),
    statusCode: integer("status_code"),
    responseTimeMs: doublePrecision("response_time_ms"),
    depth: integer("depth").notNull().default(0),

    templateFingerprint: varchar("template_fingerprint", { length: 64 }),
    contentTypeLabel: varchar("content_type_label", { length: 80 }),

    htmlSource: text("html_source"),
    renderedDomHtml: text("rendered_dom_html"),
    isClientRendered: boolean("is_client_rendered").notNull().default(false),

    title: varchar("title", { length: 500 }),
    metaDescription: text("meta_description"),
    h1Text: varchar("h1_text", { length: 500 }),
    canonical: varchar("canonical", { length: 2000 }),
    wordCount: integer("word_count").notNull().default(0),
    textHash: varchar("text_hash", { length: 64 }),
    readabilityScore: doublePrecision("readability_score"),
    lastModified: varchar("last_modified", { length: 100 }),

    lcpMs: doublePrecision("lcp_ms"),
    clsScore: doublePrecision("cls_score"),
    inpMs: doublePrecision("inp_ms"),

    accessibilityViolations: jsonb("accessibility_violations")
      .$type<{ id: string; impact: string; description: string; nodesCount: number }[]>()
      .notNull()
      .default([]),

    error: varchar("error", { length: 2000 }),
  },
  (table) => ({
    uniqueAuditUrl: uniqueIndex("uq_audit_page_url").on(table.auditId, table.url),
  }),
);

export const links = pgTable("links", {
  id: uuid("id").primaryKey().defaultRandom(),
  auditId: uuid("audit_id").notNull().references(() => audits.id, { onDelete: "cascade" }),
  sourceUrl: varchar("source_url", { length: 2000 }).notNull(),
  targetUrl: varchar("target_url", { length: 2000 }).notNull(),
  isInternal: boolean("is_internal").notNull().default(true),
});

export const screenshots = pgTable("screenshots", {
  id: uuid("id").primaryKey().defaultRandom(),
  pageId: uuid("page_id").notNull().references(() => pages.id, { onDelete: "cascade" }),
  breakpoint: varchar("breakpoint", { length: 20 }).notNull(), // mobile | tablet | desktop
  viewportWidth: integer("viewport_width").notNull(),
  // Was a local filesystem path; now a Vercel Blob URL, since serverless
  // functions have no persistent disk to write screenshots to.
  blobUrl: text("blob_url").notNull(),
  hasHorizontalScroll: boolean("has_horizontal_scroll").notNull().default(false),
  hasOverlapSuspected: boolean("has_overlap_suspected").notNull().default(false),
});

export const assets = pgTable("assets", {
  id: uuid("id").primaryKey().defaultRandom(),
  pageId: uuid("page_id").notNull().references(() => pages.id, { onDelete: "cascade" }),
  assetType: varchar("asset_type", { length: 20 }).notNull(), // image | video | document
  url: varchar("url", { length: 2000 }).notNull(),
  domain: varchar("domain", { length: 300 }),
  fileSizeBytes: integer("file_size_bytes"),
  widthPx: integer("width_px"),
  heightPx: integer("height_px"),
});

export const interactions = pgTable("interactions", {
  id: uuid("id").primaryKey().defaultRandom(),
  pageId: uuid("page_id").notNull().references(() => pages.id, { onDelete: "cascade" }),
  interactionType: varchar("interaction_type", { length: 40 }).notNull(),
  selectorSignature: varchar("selector_signature", { length: 300 }).notNull(),
});

export const findings = pgTable("findings", {
  id: uuid("id").primaryKey().defaultRandom(),
  auditId: uuid("audit_id").notNull().references(() => audits.id, { onDelete: "cascade" }),
  findingType: varchar("finding_type", { length: 80 }).notNull(),
  title: varchar("title", { length: 300 }).notNull(),
  description: text("description").notNull(),
  severity: severityEnum("severity").notNull().default("medium"),
  effortBucket: effortBucketEnum("effort_bucket").notNull().default("config"),
  personas: jsonb("personas").$type<string[]>().notNull().default([]),
  affectedPageCount: integer("affected_page_count").notNull().default(1),
  affectedUrlsSample: jsonb("affected_urls_sample").$type<string[]>().notNull().default([]),
  affectedTemplate: varchar("affected_template", { length: 64 }),
  detectionMethod: varchar("detection_method", { length: 200 }).notNull(),
  detectedAt: timestamp("detected_at", { withTimezone: true }).notNull().defaultNow(),
});

export const benchmarkInputs = pgTable("benchmark_inputs", {
  id: uuid("id").primaryKey().defaultRandom(),
  auditId: uuid("audit_id").notNull().references(() => audits.id, { onDelete: "cascade" }),
  metricName: varchar("metric_name", { length: 100 }).notNull(),
  clientStatedValue: doublePrecision("client_stated_value").notNull(),
  crawledValue: doublePrecision("crawled_value").notNull(),
  note: text("note"),
});

export const auditsRelations = relations(audits, ({ many }) => ({
  pages: many(pages),
  findings: many(findings),
}));

export const pagesRelations = relations(pages, ({ one, many }) => ({
  audit: one(audits, { fields: [pages.auditId], references: [audits.id] }),
  screenshots: many(screenshots),
  assets: many(assets),
  interactions: many(interactions),
}));
