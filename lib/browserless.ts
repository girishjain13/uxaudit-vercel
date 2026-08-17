/**
 * Remote-render a single page via Browserless's /content + /screenshot +
 * /function endpoints. This is the direct replacement for the original
 * `render_page()` in app/crawler/render.py, which drove a locally-launched
 * Playwright browser — that doesn't work in a Vercel function, so the
 * browser now lives on Browserless's infrastructure instead, called over
 * HTTP per page.
 *
 * Swap BROWSERLESS_URL/TOKEN for Browserbase's equivalent endpoints if
 * you'd rather use that provider — the shape of what's needed (rendered
 * HTML, a screenshot per breakpoint, extracted links, basic layout
 * signals) is the same either way.
 */

export type RenderResult = {
  finalUrl: string;
  statusCode: number | null;
  responseTimeMs: number;
  htmlSource: string;
  renderedDomHtml: string;
  isClientRendered: boolean;
  title: string | null;
  metaDescription: string | null;
  h1Text: string | null;
  canonical: string | null;
  wordCount: number;
  internalLinks: string[];
  externalLinks: string[];
  images: string[];
  videos: string[];
  documents: string[];
  interactions: { type: string; selector: string }[];
  screenshots: Record<"mobile" | "tablet" | "desktop", Buffer>;
  screenshotFlags: Record<string, { hasHorizontalScroll: boolean; hasSmallTapTargets: boolean }>;
  lcpMs: number | null;
  clsScore: number | null;
  inpMs: number | null;
  error: string | null;
};

const BREAKPOINTS = {
  mobile: 375,
  tablet: 768,
  desktop: 1440,
} as const;

const BASE = process.env.BROWSERLESS_URL!;
const TOKEN = process.env.BROWSERLESS_TOKEN!;

/**
 * One Browserless /function call runs a small script in-browser that
 * gathers everything render_page() used to gather in one Playwright
 * session: DOM snapshot, links, CWV-ish timing, and per-breakpoint
 * screenshots + layout heuristics (resized via page.setViewport in the
 * same session, so this stays ONE billed session per page, not four).
 */
export async function renderPage(url: string, rootHost: string): Promise<RenderResult> {
  const started = Date.now();

  const script = buildInBrowserScript(url, rootHost);

  const res = await fetch(`${BASE}/function?token=${TOKEN}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: script, context: { url } }),
  });

  if (!res.ok) {
    return errorResult(url, `browserless_http_${res.status}`, Date.now() - started);
  }

  const data = (await res.json()) as any;
  const responseTimeMs = Date.now() - started;

  return {
    finalUrl: data.finalUrl ?? url,
    statusCode: data.statusCode ?? null,
    responseTimeMs,
    htmlSource: (data.htmlSource ?? "").slice(0, 200_000),
    renderedDomHtml: (data.renderedDomHtml ?? "").slice(0, 200_000),
    isClientRendered: Boolean(data.isClientRendered),
    title: data.title ?? null,
    metaDescription: data.metaDescription ?? null,
    h1Text: data.h1Text ?? null,
    canonical: data.canonical ?? null,
    wordCount: data.wordCount ?? 0,
    internalLinks: data.internalLinks ?? [],
    externalLinks: data.externalLinks ?? [],
    images: data.images ?? [],
    videos: data.videos ?? [],
    documents: data.documents ?? [],
    interactions: data.interactions ?? [],
    screenshots: {
      mobile: Buffer.from(data.screenshots?.mobile ?? "", "base64"),
      tablet: Buffer.from(data.screenshots?.tablet ?? "", "base64"),
      desktop: Buffer.from(data.screenshots?.desktop ?? "", "base64"),
    },
    screenshotFlags: data.screenshotFlags ?? {},
    lcpMs: data.lcpMs ?? null,
    clsScore: data.clsScore ?? null,
    inpMs: data.inpMs ?? null,
    error: null,
  };
}

function errorResult(url: string, error: string, responseTimeMs: number): RenderResult {
  return {
    finalUrl: url,
    statusCode: null,
    responseTimeMs,
    htmlSource: "",
    renderedDomHtml: "",
    isClientRendered: false,
    title: null,
    metaDescription: null,
    h1Text: null,
    canonical: null,
    wordCount: 0,
    internalLinks: [],
    externalLinks: [],
    images: [],
    videos: [],
    documents: [],
    interactions: [],
    screenshots: { mobile: Buffer.alloc(0), tablet: Buffer.alloc(0), desktop: Buffer.alloc(0) },
    screenshotFlags: {},
    lcpMs: null,
    clsScore: null,
    inpMs: null,
    error,
  };
}

/**
 * NOTE: this is a starting skeleton, not a finished implementation.
 * It sketches the shape (navigate once, resize the viewport 3x for
 * screenshots + layout checks, extract links/metadata/interactions from
 * the DOM) that mirrors app/crawler/render.py's PageRenderResult. The
 * actual DOM-walking logic (link/asset extraction, interaction-pattern
 * detection for modals/accordions/carousels, tap-target sizing, axe-core
 * injection for a11y) still needs to be filled in — same TODO state the
 * original repo's render.py would need if you were finishing it there.
 */
function buildInBrowserScript(url: string, rootHost: string): string {
  return `
    export default async function ({ page, context }) {
      const started = Date.now();
      const response = await page.goto(context.url, { waitUntil: "networkidle2" });
      const statusCode = response ? response.status() : null;

      const htmlSource = await page.content(); // TODO: capture pre-JS HTML separately via fetch, not just post-render content()
      const renderedDomHtml = await page.content();

      // TODO: title/meta/h1/canonical extraction, link classification
      // (internal vs external vs asset), interaction detection, and axe-core
      // injection all go here — see app/crawler/render.py in the original
      // repo for the extraction logic to port over.

      const screenshots = {};
      const screenshotFlags = {};
      for (const [name, width] of Object.entries(${JSON.stringify(BREAKPOINTS)})) {
        await page.setViewport({ width, height: 900 });
        const buf = await page.screenshot({ encoding: "base64" });
        screenshots[name] = buf;
        const hasHorizontalScroll = await page.evaluate(
          () => document.documentElement.scrollWidth > document.documentElement.clientWidth
        );
        screenshotFlags[name] = { hasHorizontalScroll, hasSmallTapTargets: false };
      }

      return {
        data: {
          finalUrl: page.url(),
          statusCode,
          htmlSource,
          renderedDomHtml,
          isClientRendered: false,
          title: await page.title(),
          metaDescription: null,
          h1Text: null,
          canonical: null,
          wordCount: 0,
          internalLinks: [],
          externalLinks: [],
          images: [],
          videos: [],
          documents: [],
          interactions: [],
          screenshots,
          screenshotFlags,
          lcpMs: null,
          clsScore: null,
          inpMs: null,
        },
        type: "application/json",
      };
    }
  `;
}
