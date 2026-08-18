import * as cheerio from "cheerio";

/**
 * "Data & Conversion Readiness" from the spec: identify forms and
 * classify what kind each likely is, by field composition and
 * action/id/class hints — heuristic, not a guarantee, same honesty
 * standard as the rest of this codebase's pattern-matching.
 */
export type FormInfo = {
  action: string | null;
  fieldCount: number;
  fieldTypes: string[];
  likelyPurpose: "search" | "newsletter" | "contact" | "lead-gen" | "login" | "other";
};

export function detectForms(html: string): FormInfo[] {
  const $ = cheerio.load(html);
  const forms: FormInfo[] = [];

  $("form").each((_, formEl) => {
    const action = $(formEl).attr("action") ?? null;
    const fieldTypes: string[] = [];
    $(formEl)
      .find("input, textarea, select")
      .each((_, fieldEl) => {
        const type = ($(fieldEl).attr("type") || $(fieldEl).prop("tagName") || "text").toString().toLowerCase();
        fieldTypes.push(type);
      });

    const formText = `${action ?? ""} ${$(formEl).attr("class") ?? ""} ${$(formEl).attr("id") ?? ""}`.toLowerCase();
    let likelyPurpose: FormInfo["likelyPurpose"] = "other";
    if (fieldTypes.includes("search") || formText.includes("search")) {
      likelyPurpose = "search";
    } else if (formText.includes("newsletter") || formText.includes("subscribe")) {
      likelyPurpose = "newsletter";
    } else if (fieldTypes.includes("password")) {
      likelyPurpose = "login";
    } else if (formText.includes("contact")) {
      likelyPurpose = "contact";
    } else if (fieldTypes.includes("email") || fieldTypes.includes("tel")) {
      likelyPurpose = "lead-gen";
    }

    forms.push({ action, fieldCount: fieldTypes.length, fieldTypes, likelyPurpose });
  });

  return forms;
}

export function wordCountTier(wordCount: number): "Thin" | "Standard" | "Deep" {
  if (wordCount < 150) return "Thin";
  if (wordCount <= 800) return "Standard";
  return "Deep";
}
