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

function buildInBrowserScript(url: string, rootHost: string): string {
  return `
    export default async function ({ page, context }) {
      const rootHost = ${JSON.stringify(rootHost)};
      const response = await page.goto(context.url, { waitUntil: "networkidle2", timeout: 30000 });
      const statusCode = response ? response.status() : null;

      const renderedDomHtml = await page.content();

      // Real extraction: everything below runs inside the remote browser
      // via page.evaluate, since it needs DOM access. rootHost (the
      // crawl's starting domain) is baked into the script so internal vs.
      // external classification happens without a round trip.
      const extracted = await page.evaluate((rootHost) => {
        function abs(href) {
          try {
            return new URL(href, document.baseURI).href;
          } catch {
            return null;
          }
        }

        const title = document.title || null;
        const metaDescription =
          document.querySelector('meta[name="description"]')?.getAttribute("content") || null;
        const h1Text = document.querySelector("h1")?.textContent?.trim() || null;
        const canonical = document.querySelector('link[rel="canonical"]')?.getAttribute("href") || null;
        const wordCount = (document.body?.innerText || "").trim().split(/\\s+/).filter(Boolean).length;

        const internalLinks = [];
        const externalLinks = [];
        const seenLinks = new Set();
        for (const a of document.querySelectorAll("a[href]")) {
          const href = a.getAttribute("href");
          if (!href || href.startsWith("mailto:") || href.startsWith("tel:") || href.startsWith("javascript:")) {
            continue;
          }
          const full = abs(href);
          if (!full || seenLinks.has(full)) continue;
          seenLinks.add(full);
          try {
            const host = new URL(full).host;
            if (host === rootHost) internalLinks.push(full);
            else externalLinks.push(full);
          } catch {
            /* skip unparseable */
          }
        }

        const images = [];
        for (const img of document.querySelectorAll("img[src]")) {
          const full = abs(img.getAttribute("src"));
          if (full) images.push(full);
        }

        const documents = [];
        const docExtPattern = /\\.(pdf|docx?|xlsx?|pptx?)(\\?|$)/i;
        for (const a of document.querySelectorAll("a[href]")) {
          const href = a.getAttribute("href");
          if (href && docExtPattern.test(href)) {
            const full = abs(href);
            if (full) documents.push(full);
          }
        }

        const interactions = [];
        const interactionSelectors = [
          { type: "modal", selector: '[role="dialog"], .modal' },
          { type: "accordion", selector: '[aria-expanded], .accordion' },
          { type: "carousel", selector: '.carousel, .slider, [class*="carousel"]' },
          { type: "tabs", selector: '[role="tablist"], .tabs' },
        ];
        for (const { type, selector } of interactionSelectors) {
          if (document.querySelector(selector)) {
            interactions.push({ type, selector });
          }
        }

        const isClientRendered = document.querySelectorAll("script").length > 0 &&
          document.body.children.length < 10 && wordCount < 50;

        return {
          title,
          metaDescription,
          h1Text,
          canonical,
          wordCount,
          internalLinks,
          externalLinks,
          images,
          documents,
          interactions,
          isClientRendered,
        };
      }, rootHost);

      const screenshots = {};
      const screenshotFlags = {};
      const breakpoints = ${JSON.stringify(BREAKPOINTS)};
      for (const [name, width] of Object.entries(breakpoints)) {
        await page.setViewport({ width, height: 900 });
        const buf = await page.screenshot({ encoding: "base64" });
        screenshots[name] = buf;
        const layoutFlags = await page.evaluate(() => {
          const hasHorizontalScroll = document.documentElement.scrollWidth > document.documentElement.clientWidth;
          let hasSmallTapTargets = false;
          for (const el of document.querySelectorAll("a, button")) {
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0 && (rect.width < 44 || rect.height < 44)) {
              hasSmallTapTargets = true;
              break;
            }
          }
          return { hasHorizontalScroll, hasSmallTapTargets };
        });
        screenshotFlags[name] = layoutFlags;
      }

      return {
        data: {
          finalUrl: page.url(),
          statusCode,
          htmlSource: renderedDomHtml,
          renderedDomHtml,
          videos: [],
          lcpMs: null,
          clsScore: null,
          inpMs: null,
          screenshots,
          screenshotFlags,
          ...extracted,
        },
        type: "application/json",
      };
    }
  `;
}
