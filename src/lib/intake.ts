export const INTAKE_CONFIDENCES = ["high", "medium", "low"] as const;
export const INTAKE_SOURCES = [
  "user",
  "attachment",
  "current-site",
  "inspiration-site",
  "inference",
] as const;
export const INTAKE_ATTACHMENT_ROLES = [
  "logo",
  "hero",
  "services",
  "team",
  "gallery",
  "general",
  "inspiration",
  "unknown",
] as const;
export const INTAKE_FORM_REQUIREMENTS = [
  "none",
  "contact",
  "quote",
  "booking",
  "newsletter",
  "custom",
] as const;
export const INTAKE_LOGO_BACKGROUNDS = ["light", "dark", "either"] as const;

export type IntakeConfidence = (typeof INTAKE_CONFIDENCES)[number];
export type IntakeSource = (typeof INTAKE_SOURCES)[number];
export type IntakeAttachmentRole = (typeof INTAKE_ATTACHMENT_ROLES)[number];
export type IntakeFormRequirement = (typeof INTAKE_FORM_REQUIREMENTS)[number];
export type IntakeLogoBackground = (typeof INTAKE_LOGO_BACKGROUNDS)[number];

export type FieldSuggestion<T> = {
  value: T | null;
  confidence: IntakeConfidence;
  source: IntakeSource;
  evidence: string;
};

export type IntakeAttachment = {
  id: string;
  name: string;
  dataUrl: string;
  originalBytes: number;
  compressedBytes: number;
};

export type IntakeMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  attachmentIds?: string[];
  createdAt: number;
};

export type IntakeAttachmentSuggestion = {
  attachmentId: string;
  role: IntakeAttachmentRole;
  confidence: IntakeConfidence;
  evidence: string;
};

export type IntakeDraft = {
  clientName: FieldSuggestion<string>;
  currentSite: FieldSuggestion<string>;
  inspirationUrls: FieldSuggestion<string[]>;
  brandColor: FieldSuggestion<string>;
  projectBrief: FieldSuggestion<string>;
  audience: FieldSuggestion<string>;
  goals: FieldSuggestion<string>;
  mustHaves: FieldSuggestion<string>;
  formRequirement: FieldSuggestion<IntakeFormRequirement>;
  formDetails: FieldSuggestion<string>;
  avoidList: FieldSuggestion<string>;
  compNotes: FieldSuggestion<string>;
  styleNotes: FieldSuggestion<string>;
  heroDirection: FieldSuggestion<string>;
  logoBackground: FieldSuggestion<IntakeLogoBackground>;
  attachmentSuggestions: IntakeAttachmentSuggestion[];
};

export type MissingRequirement = "clientName" | "logo" | "inspirationUrl";

export type RemoteAssetCandidate = {
  id: string;
  kind: "logo" | "image";
  url: string;
  sourceUrl: string;
  label: string;
  confidence: IntakeConfidence;
};

export type ResearchContextPage = {
  url: string;
  kind: "current" | "inspiration";
  source: "firecrawl" | "provider-tools";
  title: string;
  summary: string;
  branding: string;
  colors: string[];
};

export type ResearchContext = {
  currentSite?: ResearchContextPage;
  inspirations: ResearchContextPage[];
  source: "firecrawl" | "provider-tools" | "mixed";
  assetCandidates: RemoteAssetCandidate[];
  colorCandidates: string[];
  fetchedAt: number;
};

export type ExistingIntakeForm = {
  clientName?: string;
  currentSite?: string;
  urls?: string[];
  brandColor?: string;
  projectBrief?: string;
  audience?: string;
  goals?: string;
  mustHaves?: string;
  formRequirement?: IntakeFormRequirement;
  formDetails?: string;
  avoidList?: string;
  compNotes?: string;
  styleNotes?: string;
  heroDirection?: string;
  logoBackground?: IntakeLogoBackground;
  hasLogo?: boolean;
};

export const INTAKE_FIELD_LABELS: Record<
  Exclude<keyof IntakeDraft, "attachmentSuggestions">,
  string
> = {
  clientName: "Client name",
  currentSite: "Current website",
  inspirationUrls: "Inspiration URLs",
  brandColor: "Brand colors",
  projectBrief: "Project brief",
  audience: "Audience",
  goals: "Goals and call to action",
  mustHaves: "Must include",
  formRequirement: "Form needed",
  formDetails: "Form details",
  avoidList: "Avoid",
  compNotes: "Inspiration usage notes",
  styleNotes: "Style notes",
  heroDirection: "Hero direction",
  logoBackground: "Logo background",
};

function suggestionSchema(value: Record<string, unknown>) {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      value,
      confidence: { type: "string", enum: [...INTAKE_CONFIDENCES] },
      source: { type: "string", enum: [...INTAKE_SOURCES] },
      evidence: { type: "string" },
    },
    required: ["value", "confidence", "source", "evidence"],
  };
}

const nullableString = { type: ["string", "null"] };

export const INTAKE_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    assistantMessage: { type: "string" },
    draft: {
      type: "object",
      additionalProperties: false,
      properties: {
        clientName: suggestionSchema(nullableString),
        currentSite: suggestionSchema(nullableString),
        inspirationUrls: suggestionSchema({
          anyOf: [
            { type: "array", items: { type: "string" }, maxItems: 3 },
            { type: "null" },
          ],
        }),
        brandColor: suggestionSchema(nullableString),
        projectBrief: suggestionSchema(nullableString),
        audience: suggestionSchema(nullableString),
        goals: suggestionSchema(nullableString),
        mustHaves: suggestionSchema(nullableString),
        formRequirement: suggestionSchema({
          anyOf: [
            { type: "string", enum: [...INTAKE_FORM_REQUIREMENTS] },
            { type: "null" },
          ],
        }),
        formDetails: suggestionSchema(nullableString),
        avoidList: suggestionSchema(nullableString),
        compNotes: suggestionSchema(nullableString),
        styleNotes: suggestionSchema(nullableString),
        heroDirection: suggestionSchema(nullableString),
        logoBackground: suggestionSchema({
          anyOf: [
            { type: "string", enum: [...INTAKE_LOGO_BACKGROUNDS] },
            { type: "null" },
          ],
        }),
        attachmentSuggestions: {
          type: "array",
          maxItems: 12,
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              attachmentId: { type: "string" },
              role: { type: "string", enum: [...INTAKE_ATTACHMENT_ROLES] },
              confidence: { type: "string", enum: [...INTAKE_CONFIDENCES] },
              evidence: { type: "string" },
            },
            required: ["attachmentId", "role", "confidence", "evidence"],
          },
        },
      },
      required: [
        "clientName",
        "currentSite",
        "inspirationUrls",
        "brandColor",
        "projectBrief",
        "audience",
        "goals",
        "mustHaves",
        "formRequirement",
        "formDetails",
        "avoidList",
        "compNotes",
        "styleNotes",
        "heroDirection",
        "logoBackground",
        "attachmentSuggestions",
      ],
    },
    warnings: { type: "array", items: { type: "string" }, maxItems: 12 },
  },
  required: ["assistantMessage", "draft", "warnings"],
} as const;

export function extractHttpUrls(text: string) {
  const matches = text.match(/https?:\/\/[^\s<>()\[\]{}"']+/gi) ?? [];
  const cleaned = matches.map((raw) => raw.replace(/[.,;:!?]+$/, ""));
  return Array.from(new Set(cleaned)).filter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  });
}

export function emptyIntakeDraft(): IntakeDraft {
  const empty = (): FieldSuggestion<string> => ({
    value: null,
    confidence: "low",
    source: "inference",
    evidence: "Not established yet.",
  });
  return {
    clientName: empty(),
    currentSite: empty(),
    inspirationUrls: { ...empty(), value: null } as FieldSuggestion<string[]>,
    brandColor: empty(),
    projectBrief: empty(),
    audience: empty(),
    goals: empty(),
    mustHaves: empty(),
    formRequirement: { ...empty(), value: null } as FieldSuggestion<IntakeFormRequirement>,
    formDetails: empty(),
    avoidList: empty(),
    compNotes: empty(),
    styleNotes: empty(),
    heroDirection: empty(),
    logoBackground: { ...empty(), value: null } as FieldSuggestion<IntakeLogoBackground>,
    attachmentSuggestions: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanText(value: unknown, max: number) {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("Expected text or null");
  return value.trim().slice(0, max) || null;
}

function validUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function parseSuggestion<T>(
  value: unknown,
  parseValue: (input: unknown) => T | null,
): FieldSuggestion<T> {
  if (!isRecord(value)) throw new Error("Invalid field suggestion");
  const confidence = value.confidence;
  const source = value.source;
  if (!INTAKE_CONFIDENCES.includes(confidence as IntakeConfidence)) {
    throw new Error("Invalid suggestion confidence");
  }
  if (!INTAKE_SOURCES.includes(source as IntakeSource)) {
    throw new Error("Invalid suggestion source");
  }
  return {
    value: parseValue(value.value),
    confidence: confidence as IntakeConfidence,
    source: source as IntakeSource,
    evidence: cleanText(value.evidence, 280) ?? "No evidence supplied.",
  };
}

export function validateIntakeDraft(value: unknown, attachmentIds: Set<string>): IntakeDraft {
  if (!isRecord(value)) throw new Error("Intake draft was not an object");
  const text = (max = 4_000) => (input: unknown) => cleanText(input, max);
  const enumValue = <T extends string>(allowed: readonly T[]) => (input: unknown) => {
    if (input === null) return null;
    if (typeof input !== "string" || !allowed.includes(input as T)) {
      throw new Error("Invalid enum suggestion");
    }
    return input as T;
  };
  const url = (input: unknown) => {
    const result = cleanText(input, 2_048);
    if (result && !validUrl(result)) throw new Error("Invalid suggested URL");
    return result;
  };
  const urls = (input: unknown) => {
    if (input === null) return null;
    if (!Array.isArray(input)) throw new Error("Invalid inspiration URL list");
    const result = Array.from(
      new Set(input.map((item) => cleanText(item, 2_048)).filter(Boolean)),
    ) as string[];
    if (result.length > 3 || result.some((item) => !validUrl(item))) {
      throw new Error("Invalid inspiration URL list");
    }
    return result.length ? result : null;
  };
  const color = (input: unknown) => {
    const result = cleanText(input, 120);
    if (!result) return null;
    const normalized = result
      .split(",")
      .map((part) => part.trim().toUpperCase())
      .filter(Boolean)
      .map((part) => (part.startsWith("#") ? part : `#${part}`));
    if (!normalized.length || normalized.some((part) => !/^#[0-9A-F]{6}$/.test(part))) {
      throw new Error("Invalid suggested brand colors");
    }
    return normalized.slice(0, 8).join(", ");
  };

  const rawAttachments = value.attachmentSuggestions;
  if (!Array.isArray(rawAttachments)) throw new Error("Invalid attachment suggestions");
  const attachmentSuggestions = rawAttachments.slice(0, 12).map((item) => {
    if (!isRecord(item)) throw new Error("Invalid attachment suggestion");
    const attachmentId = cleanText(item.attachmentId, 100);
    if (!attachmentId || !attachmentIds.has(attachmentId)) {
      throw new Error("Attachment suggestion references an unknown image");
    }
    if (!INTAKE_ATTACHMENT_ROLES.includes(item.role as IntakeAttachmentRole)) {
      throw new Error("Invalid attachment role");
    }
    if (!INTAKE_CONFIDENCES.includes(item.confidence as IntakeConfidence)) {
      throw new Error("Invalid attachment confidence");
    }
    return {
      attachmentId,
      role: item.role as IntakeAttachmentRole,
      confidence: item.confidence as IntakeConfidence,
      evidence: cleanText(item.evidence, 280) ?? "Visual classification.",
    };
  });

  return {
    clientName: parseSuggestion(value.clientName, text(200)),
    currentSite: parseSuggestion(value.currentSite, url),
    inspirationUrls: parseSuggestion(value.inspirationUrls, urls),
    brandColor: parseSuggestion(value.brandColor, color),
    projectBrief: parseSuggestion(value.projectBrief, text()),
    audience: parseSuggestion(value.audience, text(1_000)),
    goals: parseSuggestion(value.goals, text(1_000)),
    mustHaves: parseSuggestion(value.mustHaves, text(2_000)),
    formRequirement: parseSuggestion(
      value.formRequirement,
      enumValue(INTAKE_FORM_REQUIREMENTS),
    ),
    formDetails: parseSuggestion(value.formDetails, text(2_000)),
    avoidList: parseSuggestion(value.avoidList, text(2_000)),
    compNotes: parseSuggestion(value.compNotes, text(2_000)),
    styleNotes: parseSuggestion(value.styleNotes, text(2_000)),
    heroDirection: parseSuggestion(value.heroDirection, text(2_000)),
    logoBackground: parseSuggestion(
      value.logoBackground,
      enumValue(INTAKE_LOGO_BACKGROUNDS),
    ),
    attachmentSuggestions,
  };
}

export function computeMissingRequirements(args: {
  draft: IntakeDraft;
  existingForm?: ExistingIntakeForm;
  attachmentRoles?: Record<string, IntakeAttachmentRole>;
}) {
  const missing: MissingRequirement[] = [];
  if (!args.draft.clientName.value && !args.existingForm?.clientName?.trim()) {
    missing.push("clientName");
  }
  const suggestedLogo = Object.values(args.attachmentRoles ?? {}).includes("logo");
  if (!args.existingForm?.hasLogo && !suggestedLogo) missing.push("logo");
  const hasInspiration = Boolean(
    args.draft.inspirationUrls.value?.length ||
      args.existingForm?.urls?.some((url) => url.trim()),
  );
  if (!hasInspiration) missing.push("inspirationUrl");
  return missing;
}
