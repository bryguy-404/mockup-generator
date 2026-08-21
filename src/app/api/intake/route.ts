import { NextResponse } from "next/server";
import {
  INTAKE_FORM_REQUIREMENTS,
  INTAKE_LOGO_BACKGROUNDS,
  INTAKE_OUTPUT_SCHEMA,
  computeMissingRequirements,
  extractHttpUrls,
  validateIntakeDraft,
  type ExistingIntakeForm,
  type IntakeAttachment,
  type IntakeAttachmentRole,
  type IntakeMessage,
  type ResearchContext,
} from "@/lib/intake";
import {
  MODEL_OUTPUT_TOKENS,
  extractOpenAIText,
  getOpenAIIntakeConfig,
} from "@/lib/ai-models";
import { createAndPollOpenAIResponse } from "@/lib/openai-responses";
import { buildResearchPacket, toResearchContext } from "@/lib/research";

export const runtime = "nodejs";
export const maxDuration = 180;

const MAX_MESSAGES = 20;
const MAX_ATTACHMENTS = 12;
const MAX_MESSAGE_CHARS = 12_000;
const MAX_TOTAL_TEXT_CHARS = 60_000;
const MAX_ATTACHMENT_DATA_URL_LENGTH = 2.2 * 1024 * 1024;
const INTAKE_DEADLINE_MS = 165_000;

type RequestBody = {
  messages?: unknown;
  attachments?: unknown;
  existingForm?: unknown;
  researchContext?: unknown;
};

type ParsedImage = {
  mediaType: "image/png" | "image/jpeg" | "image/gif" | "image/webp";
  base64: string;
};

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value: unknown, max: number) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function parseImageDataUrl(dataUrl: string): ParsedImage | null {
  const match = dataUrl.match(/^data:(image\/(png|jpeg|gif|webp));base64,([\s\S]+)$/);
  if (!match) return null;
  return {
    mediaType: match[1] as ParsedImage["mediaType"],
    base64: match[3],
  };
}

function parseMessages(value: unknown): IntakeMessage[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_MESSAGES) {
    throw new Error(`Provide between 1 and ${MAX_MESSAGES} intake messages`);
  }
  let totalChars = 0;
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error("Each intake message must be an object");
    const role = item.role === "assistant" ? "assistant" : item.role === "user" ? "user" : null;
    if (!role) throw new Error("Intake message role must be user or assistant");
    const text = cleanString(item.text, MAX_MESSAGE_CHARS);
    if (!text) throw new Error("Intake messages cannot be empty");
    totalChars += text.length;
    if (totalChars > MAX_TOTAL_TEXT_CHARS) throw new Error("Intake conversation is too long");
    const attachmentIds = Array.isArray(item.attachmentIds)
      ? item.attachmentIds
          .filter((id): id is string => typeof id === "string")
          .slice(0, MAX_ATTACHMENTS)
      : undefined;
    return {
      id: cleanString(item.id, 100) || `message_${index + 1}`,
      role,
      text,
      attachmentIds,
      createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
    };
  });
}

function parseAttachments(value: unknown): Array<IntakeAttachment & { parsed: ParsedImage }> {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) {
    throw new Error(`Provide at most ${MAX_ATTACHMENTS} intake images`);
  }
  const seen = new Set<string>();
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error("Each intake attachment must be an object");
    const id = cleanString(item.id, 100) || `attachment_${index + 1}`;
    if (!/^[A-Za-z0-9_-]+$/.test(id) || seen.has(id)) {
      throw new Error("Attachment IDs must be unique letters, numbers, dashes, or underscores");
    }
    seen.add(id);
    const dataUrl = typeof item.dataUrl === "string" ? item.dataUrl : "";
    if (!dataUrl || dataUrl.length > MAX_ATTACHMENT_DATA_URL_LENGTH) {
      throw new Error(`${cleanString(item.name, 160) || id} is too large`);
    }
    const parsed = parseImageDataUrl(dataUrl);
    if (!parsed) throw new Error(`${cleanString(item.name, 160) || id} is not a supported image`);
    return {
      id,
      name: cleanString(item.name, 160) || `Attachment ${index + 1}`,
      dataUrl,
      originalBytes: typeof item.originalBytes === "number" ? item.originalBytes : 0,
      compressedBytes: typeof item.compressedBytes === "number" ? item.compressedBytes : 0,
      parsed,
    };
  });
}

function parseExistingForm(value: unknown): ExistingIntakeForm {
  if (!isRecord(value)) return {};
  const formRequirement = INTAKE_FORM_REQUIREMENTS.includes(
    value.formRequirement as (typeof INTAKE_FORM_REQUIREMENTS)[number],
  )
    ? (value.formRequirement as ExistingIntakeForm["formRequirement"])
    : undefined;
  const logoBackground = INTAKE_LOGO_BACKGROUNDS.includes(
    value.logoBackground as (typeof INTAKE_LOGO_BACKGROUNDS)[number],
  )
    ? (value.logoBackground as ExistingIntakeForm["logoBackground"])
    : undefined;
  return {
    clientName: cleanString(value.clientName, 200),
    currentSite: cleanString(value.currentSite, 2_048),
    urls: Array.isArray(value.urls)
      ? value.urls.filter((url): url is string => typeof url === "string").slice(0, 3)
      : [],
    brandColor: cleanString(value.brandColor, 120),
    projectBrief: cleanString(value.projectBrief, 4_000),
    audience: cleanString(value.audience, 1_000),
    goals: cleanString(value.goals, 1_000),
    mustHaves: cleanString(value.mustHaves, 2_000),
    formRequirement,
    formDetails: cleanString(value.formDetails, 2_000),
    avoidList: cleanString(value.avoidList, 2_000),
    compNotes: cleanString(value.compNotes, 2_000),
    styleNotes: cleanString(value.styleNotes, 2_000),
    heroDirection: cleanString(value.heroDirection, 2_000),
    logoBackground,
    hasLogo: value.hasLogo === true,
  };
}

function isFreshResearchContext(
  value: unknown,
  currentSite: string,
  inspirationUrls: string[],
): value is ResearchContext {
  if (!isRecord(value) || typeof value.fetchedAt !== "number") return false;
  if (Date.now() - value.fetchedAt > 30 * 60 * 1_000) return false;
  if (!Array.isArray(value.inspirations) || !Array.isArray(value.assetCandidates)) return false;
  const contextCurrent = isRecord(value.currentSite) && typeof value.currentSite.url === "string"
    ? value.currentSite.url
    : "";
  const contextInspirations = value.inspirations
    .filter(isRecord)
    .map((page) => (typeof page.url === "string" ? page.url : ""))
    .filter(Boolean);
  return (
    contextCurrent === currentSite &&
    inspirationUrls.every((url) => contextInspirations.includes(url))
  );
}

function classifyUrls(messages: IntakeMessage[], existingForm: ExistingIntakeForm) {
  const transcript = messages.map((message) => message.text).join("\n");
  const discovered = extractHttpUrls(transcript);
  const currentSite = existingForm.currentSite?.trim() || "";
  const inspirations = (existingForm.urls ?? []).filter(Boolean);
  if (currentSite || inspirations.length) {
    return {
      currentSite,
      inspirationUrls: Array.from(
        new Set([...inspirations, ...discovered.filter((url) => url !== currentSite)]),
      ).slice(0, 3),
    };
  }
  if (discovered.length === 1) {
    const url = discovered[0];
    const index = transcript.indexOf(url);
    const nearby = transcript.slice(Math.max(0, index - 100), index).toLowerCase();
    const looksInspirational = /inspir|competitor|comp|like this|reference/.test(nearby);
    return looksInspirational
      ? { currentSite: "", inspirationUrls: [url] }
      : { currentSite: url, inspirationUrls: [] };
  }
  return {
    currentSite: discovered[0] ?? "",
    inspirationUrls: discovered.slice(1, 4),
  };
}

function promptForIntake(args: {
  messages: IntakeMessage[];
  existingForm: ExistingIntakeForm;
  attachments: IntakeAttachment[];
  researchContext: ResearchContext;
}) {
  const transcript = args.messages
    .map((message) => `${message.role.toUpperCase()}: ${message.text}`)
    .join("\n\n");
  return `You are the AI intake strategist for a premium website mockup generator. Convert the conversation, attached images, and website research into a conservative, evidence-backed form draft.

SOURCE PRECEDENCE:
1. The user's explicit statements in the conversation.
2. Uploaded attachments.
3. The client's current website for factual brand truth.
4. Inspiration websites for visual direction only.
5. Clearly labeled inference.

RULES:
- Never invent a client name, URL, service, CTA, form requirement, or factual claim.
- Use null when a field is genuinely unknown or ambiguous.
- Existing non-empty manual form values are authoritative unless the latest user message explicitly asks to replace them.
- Current-site copy and facts must not be taken from an inspiration or competitor site.
- Return brandColor only as one or more six-digit hex colors separated by commas.
- Classify every attachment ID exactly once. Use unknown when unsure.
- Keep evidence under 30 words and never include secrets or base64 data.
- assistantMessage should summarize what was learned and ask at most three concise follow-up questions, prioritizing missing client name, logo, and inspiration URL.
- The app still requires a client name, an actual logo image, and at least one inspiration URL before generation.

CURRENT MANUAL FORM:
${JSON.stringify(args.existingForm, null, 2)}

ATTACHMENTS:
${JSON.stringify(args.attachments.map(({ id, name }) => ({ id, name })), null, 2)}

RESEARCH CONTEXT:
${JSON.stringify(args.researchContext, null, 2)}

CONVERSATION:
${transcript}`;
}

export async function POST(request: Request) {
  const startedAt = Date.now();
  const deadlineAt = startedAt + INTAKE_DEADLINE_MS;
  let body: RequestBody;
  try {
    body = (await request.json()) as RequestBody;
  } catch {
    return badRequest("Request body must be JSON");
  }

  let messages: IntakeMessage[];
  let attachments: Array<IntakeAttachment & { parsed: ParsedImage }>;
  let existingForm: ExistingIntakeForm;
  try {
    messages = parseMessages(body.messages);
    attachments = parseAttachments(body.attachments);
    existingForm = parseExistingForm(body.existingForm);
  } catch (error) {
    return badRequest(error instanceof Error ? error.message : "Invalid intake request");
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Server is missing OPENAI_API_KEY" }, { status: 500 });
  }

  const { currentSite, inspirationUrls } = classifyUrls(messages, existingForm);
  let researchContext: ResearchContext | undefined;
  let usedSuppliedResearch = false;
  try {
    if (isFreshResearchContext(body.researchContext, currentSite, inspirationUrls)) {
      researchContext = body.researchContext;
      usedSuppliedResearch = true;
    } else {
      const packet = await buildResearchPacket(currentSite, inspirationUrls, {
        deadlineAt,
        signal: request.signal,
      });
      researchContext = toResearchContext(packet);
    }
    if (!researchContext) throw new Error("Website research returned no context");

    const config = getOpenAIIntakeConfig();
    const prompt = promptForIntake({
      messages,
      existingForm,
      attachments,
      researchContext,
    });
    const content = [
      ...attachments.map((attachment) => ({
        type: "input_image",
        image_url: `data:${attachment.parsed.mediaType};base64,${attachment.parsed.base64}`,
        detail: "auto",
      })),
      { type: "input_text", text: prompt },
    ];
    const response = await createAndPollOpenAIResponse({
      apiKey,
      deadlineAt,
      signal: request.signal,
      body: {
        model: config.model,
        input: [{ role: "user", content }],
        max_output_tokens: MODEL_OUTPUT_TOKENS.intake,
        reasoning: { effort: config.reasoningEffort },
        text: {
          format: {
            type: "json_schema",
            name: "mockup_intake_draft",
            strict: true,
            schema: INTAKE_OUTPUT_SCHEMA,
          },
        },
        ...(researchContext.source === "provider-tools"
          ? {
              tools: [{ type: "web_search", search_context_size: "medium" }],
              max_tool_calls: 6,
            }
          : {}),
        store: false,
      },
    });
    const text = extractOpenAIText(response);
    const parsed = JSON.parse(text) as unknown;
    if (!isRecord(parsed)) throw new Error("OpenAI returned an invalid intake object");
    const draft = validateIntakeDraft(parsed.draft, new Set(attachments.map((item) => item.id)));
    const assistantMessage = cleanString(parsed.assistantMessage, 4_000);
    if (!assistantMessage) throw new Error("OpenAI returned an empty intake message");
    const warnings = Array.isArray(parsed.warnings)
      ? parsed.warnings
          .filter((warning): warning is string => typeof warning === "string")
          .map((warning) => warning.trim().slice(0, 500))
          .filter(Boolean)
          .slice(0, 12)
      : [];
    if (researchContext.source !== "firecrawl") {
      warnings.unshift(
        researchContext.source === "mixed"
          ? "Some websites could not be read by Firecrawl; those suggestions may have lower confidence."
          : "Firecrawl research was unavailable; OpenAI web search was used as a fallback.",
      );
    }
    const attachmentRoles = Object.fromEntries(
      draft.attachmentSuggestions.map((item) => [item.attachmentId, item.role]),
    ) as Record<string, IntakeAttachmentRole>;
    const missingRequired = computeMissingRequirements({
      draft,
      existingForm,
      attachmentRoles,
    });

    console.log("[intake] success", {
      model: config.model,
      reasoningEffort: config.reasoningEffort,
      researchSource: researchContext.source,
      reusedResearch: usedSuppliedResearch,
      messages: messages.length,
      attachments: attachments.length,
      missingRequired,
      elapsedMs: Date.now() - startedAt,
    });
    return NextResponse.json({
      assistantMessage,
      draft,
      missingRequired,
      warnings,
      researchContext,
      usedModel: config.model,
    });
  } catch (error) {
    const message =
      request.signal.aborted
        ? "Intake analysis was cancelled"
        : error instanceof Error
          ? error.message
          : "Intake analysis failed";
    const lower = message.toLowerCase();
    const status = lower.includes("rate") || lower.includes("429")
      ? 429
      : lower.includes("deadline") || lower.includes("timed out")
        ? 504
        : 500;
    console.error("[intake] failed", {
      status,
      category: status === 429 ? "rate_limit" : status === 504 ? "timeout" : "provider",
      researchSource: researchContext?.source,
      elapsedMs: Date.now() - startedAt,
    });
    return NextResponse.json({ error: message }, { status });
  }
}
