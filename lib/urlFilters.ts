/**
 * Root cause of "32 rendered successfully, 468 failed" on a real crawl:
 * nothing filtered document/media file URLs (PDFs especially — very
 * common on compliance-heavy sites) out of the set of pages queued for
 * headless rendering. A PDF has no <title>, no DOM structure a browser
 * extraction script expects — queuing it as a "page" either fails
 * outright or produces meaningless empty-HTML findings, and burns
 * through the maxPages budget on things that were never going to work.
 *
 * These should be captured as document ASSETS (see the `assets` table
 * and `documents` array in lib/browserless.ts's extraction) — not
 * queued as pages. This filter is checked at every place a URL gets
 * added to the crawl queue: sitemap seeding, link-discovery during
 * crawling, and (duplicated inline, since it can't import this module)
 * inside the Browserless in-browser extraction script itself.
 */
const NON_HTML_EXTENSIONS = [
  "pdf", "docx?", "xlsx?", "pptx?", "csv", "rtf",
  "zip", "rar", "7z", "tar", "gz",
  "jpe?g", "png", "gif", "svg", "webp", "ico", "bmp", "tiff?",
  "mp4", "mp3", "wav", "avi", "mov", "webm", "ogg",
  "woff2?", "ttf", "eot",
  "xml", "json",
];

const NON_HTML_URL_PATTERN = new RegExp(`\\.(${NON_HTML_EXTENSIONS.join("|")})(\\?|#|$)`, "i");

export function isLikelyNonHtmlResource(url: string): boolean {
  try {
    return NON_HTML_URL_PATTERN.test(new URL(url).pathname);
  } catch {
    return false;
  }
}
