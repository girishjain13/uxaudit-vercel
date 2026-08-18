/**
 * Port of the reference's analyzers/media.py, using our existing
 * `assets` table (domain field per image/video/document already
 * captured during crawl — no new data needed).
 *
 * Same honest scope note as the source: file size and pixel dimensions
 * (which the original spec asked for) aren't available without adding
 * a real HTTP request per asset — a genuine cost/time tradeoff for a
 * lean crawl, not an oversight. What's here is presence, hosting
 * domain, and file type — still enough to answer "is this content
 * governed in one place or not."
 */
export type MediaResult = {
  totalImages: number;
  imageDomains: Record<string, number>;
  dominantImageDomain: string | null;
  offDominantDomainImageCount: number;
  offDominantDomainPct: number;
  videoEmbedCount: number;
  documentCountsByType: Record<string, number>;
  documentTotal: number;
  documentExamples: string[];
};

export function runMediaAnalysis(
  assets: { assetType: string; url: string; domain: string | null }[],
): MediaResult {
  const imageDomainCounts = new Map<string, number>();
  let videoEmbedCount = 0;
  const documentExtensionCounts = new Map<string, number>();
  const documentExamples: string[] = [];

  for (const a of assets) {
    if (a.assetType === "image") {
      const domain = a.domain ?? "unknown";
      imageDomainCounts.set(domain, (imageDomainCounts.get(domain) ?? 0) + 1);
    } else if (a.assetType === "video") {
      videoEmbedCount++;
    } else if (a.assetType === "document") {
      const ext = a.url.match(/\.([a-z0-9]+)(?:\?|$)/i)?.[1]?.toLowerCase() ?? "unknown";
      documentExtensionCounts.set(ext, (documentExtensionCounts.get(ext) ?? 0) + 1);
      documentExamples.push(a.url);
    }
  }

  const totalImages = [...imageDomainCounts.values()].reduce((a, b) => a + b, 0);
  const sortedDomains = [...imageDomainCounts.entries()].sort((a, b) => b[1] - a[1]);
  const [dominantDomain, dominantCount] = sortedDomains[0] ?? [null, 0];
  const offDominantTotal = totalImages - dominantCount;

  return {
    totalImages,
    imageDomains: Object.fromEntries(sortedDomains.slice(0, 20)),
    dominantImageDomain: dominantDomain,
    offDominantDomainImageCount: offDominantTotal,
    offDominantDomainPct: totalImages ? Math.round((100 * offDominantTotal) / totalImages * 10) / 10 : 0,
    videoEmbedCount,
    documentCountsByType: Object.fromEntries(documentExtensionCounts),
    documentTotal: [...documentExtensionCounts.values()].reduce((a, b) => a + b, 0),
    documentExamples: documentExamples.slice(0, 15),
  };
}
