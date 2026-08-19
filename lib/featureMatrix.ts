import * as cheerio from "cheerio";
import { detectForms } from "./formDetection";

/**
 * Matches the "Feature Matrix" sheet from the reference export exactly —
 * this is the Business Analyst persona's "evaluate whether expected
 * website functionality appears to be present" requirement. Detection
 * is heuristic (URL patterns, form field composition, known script
 * domains) — a feature genuinely present but named unusually (e.g. a
 * search page at /find-it instead of /search) can be missed. This is a
 * discovery-phase signal, not a definitive functional inventory.
 */

const URL_PATTERN_FEATURES: { feature: string; pattern: RegExp }[] = [
  { feature: "Blog / Articles", pattern: /\/(blog|articles?|insights|news)(\/|$)/i },
  { feature: "FAQ / Help Center", pattern: /\/(faq|help|support)(\/|$)/i },
  { feature: "Pricing / Plans", pattern: /\/(pricing|plans)(\/|$)/i },
  { feature: "Careers / Jobs", pattern: /\/(careers?|jobs)(\/|$)/i },
  { feature: "E-commerce (cart / checkout)", pattern: /\/(cart|checkout|shop|basket)(\/|$)/i },
  { feature: "Store/Office Locations", pattern: /\/(locations?|branches|stores?|find-us|near-me)(\/|$)/i },
];

const CHAT_WIDGET_DOMAINS = ["intercom.io", "intercomcdn", "drift.com", "zdassets.com", "livechatinc.com", "tawk.to", "hubspot.com/conversations"];

export type FeatureResult = { feature: string; detected: boolean; pagesFoundOn: number };

export function detectFeaturesAcrossSite(
  pages: { url: string; renderedDomHtml: string | null; hasMultipleLocales: boolean }[],
): FeatureResult[] {
  const counts = new Map<string, number>();
  const bump = (feature: string) => counts.set(feature, (counts.get(feature) ?? 0) + 1);

  let anyMultilingual = false;

  for (const p of pages) {
    for (const { feature, pattern } of URL_PATTERN_FEATURES) {
      if (pattern.test(p.url)) bump(feature);
    }
    if (p.hasMultipleLocales) anyMultilingual = true;

    if (!p.renderedDomHtml) continue;
    const html = p.renderedDomHtml;
    const $ = cheerio.load(html);

    for (const form of detectForms(html)) {
      if (form.likelyPurpose === "search") bump("Site Search");
      if (form.likelyPurpose === "login") bump("User Login / Account");
      if (form.likelyPurpose === "newsletter") bump("Newsletter Signup");
      if (form.likelyPurpose === "contact") bump("Contact Form");
    }
    // Registration is distinguished from login by field composition —
    // multiple fields including email + a password-confirmation-shaped
    // second password field, or explicit "register"/"signup" hints.
    const formsText = $("form").toArray().map((f) => `${$(f).attr("action") ?? ""} ${$(f).attr("class") ?? ""} ${$(f).attr("id") ?? ""}`).join(" ").toLowerCase();
    if (/regist|sign-?up|create-?account/.test(formsText) || /regist|sign-?up|create-?account/i.test(p.url)) {
      bump("User Registration / Signup");
    }

    if ($("video, iframe[src*='youtube'], iframe[src*='vimeo']").length > 0) bump("Video Content");

    const bodyText = $("body").text().toLowerCase();
    if (/testimonial|customer review|what our (customers|clients) say/.test(bodyText)) bump("Testimonials / Reviews");

    if ($("a[href$='.pdf'], a[href$='.doc'], a[href$='.docx'], a[href$='.xls'], a[href$='.xlsx']").length > 0) {
      bump("Downloadable Resources");
    }

    $("script[src]").each((_, el) => {
      const src = $(el).attr("src") ?? "";
      if (CHAT_WIDGET_DOMAINS.some((d) => src.includes(d))) bump("Live Chat Widget");
    });
  }

  const featureOrder = [
    "Site Search",
    "User Login / Account",
    "User Registration / Signup",
    "E-commerce (cart / checkout)",
    "Newsletter Signup",
    "Blog / Articles",
    "FAQ / Help Center",
    "Pricing / Plans",
    "Careers / Jobs",
    "Multi-language Support",
    "Video Content",
    "Testimonials / Reviews",
    "Downloadable Resources",
    "Contact Form",
    "Store/Office Locations",
    "Live Chat Widget",
  ];

  return featureOrder.map((feature) => {
    if (feature === "Multi-language Support") {
      return { feature, detected: anyMultilingual, pagesFoundOn: anyMultilingual ? pages.length : 0 };
    }
    const count = counts.get(feature) ?? 0;
    return { feature, detected: count > 0, pagesFoundOn: count };
  });
}
