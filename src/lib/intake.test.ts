import { describe, expect, it } from "vitest";
import {
  computeMissingRequirements,
  emptyIntakeDraft,
  extractHttpUrls,
  validateIntakeDraft,
  type IntakeDraft,
} from "@/lib/intake";

function suggestion(value: unknown, source = "user") {
  return { value, confidence: "high", source, evidence: "The user said so." };
}

function rawDraft(overrides: Record<string, unknown> = {}) {
  return {
    clientName: suggestion("Acme Roofing"),
    currentSite: suggestion("https://acme.example"),
    inspirationUrls: suggestion(["https://inspiration.example"]),
    brandColor: suggestion("1a2b3c, #FFFFFF"),
    projectBrief: suggestion("A lead-generation website."),
    audience: suggestion("Homeowners"),
    goals: suggestion("Request estimates"),
    mustHaves: suggestion("Reviews"),
    formRequirement: suggestion("quote"),
    formDetails: suggestion("Name, email, project type"),
    avoidList: suggestion("No generic stock-photo feel"),
    compNotes: suggestion("Use the inspiration for layout only"),
    styleNotes: suggestion("Established and modern"),
    heroDirection: suggestion("Split layout"),
    logoBackground: suggestion("light"),
    attachmentSuggestions: [],
    ...overrides,
  };
}

describe("intake validation", () => {
  it("normalizes valid colors and preserves sourced values", () => {
    const draft = validateIntakeDraft(rawDraft(), new Set());
    expect(draft.clientName.value).toBe("Acme Roofing");
    expect(draft.brandColor.value).toBe("#1A2B3C, #FFFFFF");
    expect(draft.inspirationUrls.value).toEqual(["https://inspiration.example"]);
  });

  it("rejects malformed URLs and unknown attachment IDs", () => {
    expect(() =>
      validateIntakeDraft(rawDraft({ currentSite: suggestion("javascript:alert(1)") }), new Set()),
    ).toThrow("Invalid suggested URL");
    expect(() =>
      validateIntakeDraft(
        rawDraft({
          attachmentSuggestions: [
            { attachmentId: "missing", role: "logo", confidence: "high", evidence: "Looks like a logo." },
          ],
        }),
        new Set(),
      ),
    ).toThrow("unknown image");
  });

  it("leaves genuinely unknown fields null", () => {
    const empty = emptyIntakeDraft();
    expect(empty.clientName.value).toBeNull();
    expect(empty.formRequirement.value).toBeNull();
  });
});

describe("intake requirements", () => {
  it("reports all unchanged generation minimums", () => {
    const missing = computeMissingRequirements({ draft: emptyIntakeDraft() });
    expect(missing).toEqual(["clientName", "logo", "inspirationUrl"]);
  });

  it("accepts a suggested logo plus drafted required text", () => {
    const draft = {
      ...emptyIntakeDraft(),
      clientName: suggestion("Acme") as IntakeDraft["clientName"],
      inspirationUrls: suggestion(["https://example.com"]) as IntakeDraft["inspirationUrls"],
    };
    expect(
      computeMissingRequirements({
        draft,
        attachmentRoles: { logo_1: "logo" },
      }),
    ).toEqual([]);
  });
});

describe("URL extraction", () => {
  it("deduplicates links and trims sentence punctuation", () => {
    expect(
      extractHttpUrls(
        "Current site: https://acme.example. Inspiration: https://look.example, and https://acme.example",
      ),
    ).toEqual(["https://acme.example", "https://look.example"]);
  });
});
