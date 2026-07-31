import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import {
  MODEL_OUTPUT_TOKENS,
  assertAnthropicResponseComplete,
  extractOpenAIText,
  getAnthropicMockupConfig,
  getOpenAIMockupConfig,
} from "@/lib/ai-models";
import { createAndPollOpenAIResponse } from "@/lib/openai-responses";

export const runtime = "nodejs";
export const maxDuration = 900;

const ROUTE_WORK_DEADLINE_MS = 13 * 60 * 1_000;
const MIN_QA_RENDER_BUDGET_MS = 100_000;
const MIN_REPAIR_START_BUDGET_MS = 2 * 60 * 1_000;

type Mockup = { name: string; html: string };
type LogoBackground = "light" | "dark" | "either";
type GenerationProvider = "anthropic" | "openai";
type QualityMode = "premium";
type FormRequirement =
  | "none"
  | "contact"
  | "quote"
  | "booking"
  | "newsletter"
  | "custom";
type ClientImageRole = "hero" | "services" | "team" | "gallery" | "general";
type AllowedImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";
type ParsedImage = { mediaType: AllowedImageMediaType; base64: string; label?: string };
type ClientImageAsset = {
  id: string;
  name: string;
  role: ClientImageRole;
  dataUrl: string;
};
type ResearchPage = {
  url: string;
  kind: "current" | "inspiration";
  source: "firecrawl" | "provider-tools";
  markdown: string;
  screenshotDataUrl?: string;
  links: string[];
  images: string[];
  branding: unknown;
  error?: string;
};
type ResearchPacket = {
  currentSite?: ResearchPage;
  inspirations: ResearchPage[];
  source: "firecrawl" | "provider-tools" | "mixed";
};
type CreativeDirection = {
  name: string;
  angle: string;
  palette: string;
  typography: string;
  layout: string;
  imagery: string;
};
type DesignAnalysis = {
  brandProfile: string;
  inspirationProfile: string;
  directions: CreativeDirection[];
};
type MockupQAReport = {
  name: string;
  pass: boolean;
  score: number;
  issues: string[];
  repairInstructions: string;
};

type RequestBody = {
  urls?: unknown;
  currentSite?: unknown;
  logoDataUrl?: unknown;
  brandColor?: unknown;
  clientName?: unknown;
  screenshots?: unknown;
  heroPhotoDataUrl?: unknown;
  heroDirection?: unknown;
  logoBackground?: unknown;
  generationProvider?: unknown;
  projectBrief?: unknown;
  clientImages?: unknown;
  audience?: unknown;
  goals?: unknown;
  mustHaves?: unknown;
  formRequirement?: unknown;
  formDetails?: unknown;
  avoidList?: unknown;
  compNotes?: unknown;
  styleNotes?: unknown;
  qualityMode?: unknown;
};

const LOGO_PLACEHOLDER = "__LOGO_DATA_URL__";
const HERO_IMAGE_PLACEHOLDER = "__HERO_IMAGE_DATA_URL__";
const MAX_SCREENSHOTS = 3;
const MAX_CLIENT_IMAGES = 12;
const MAX_LOGO_DATA_URL_BYTES = 2.2 * 1024 * 1024;
const MAX_SCREENSHOT_DATA_URL_BYTES = 7 * 1024 * 1024;
const MAX_CLIENT_IMAGE_DATA_URL_BYTES = 2.2 * 1024 * 1024;
const MAX_TOTAL_CLIENT_IMAGE_BYTES = 18 * 1024 * 1024;
const MAX_RESEARCH_CHARS_PER_PAGE = 12000;
const MAX_REPAIR_PASSES = 1;
const MAX_ANTHROPIC_PAUSE_CONTINUATIONS = 3;

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

function parseImageDataUrl(dataUrl: string): ParsedImage | null {
  const match = dataUrl.match(/^data:(image\/(png|jpeg|gif|webp));base64,([\s\S]+)$/);
  if (!match) return null;
  return {
    mediaType: match[1] as AllowedImageMediaType,
    base64: match[3],
  };
}

function truncate(s: string, max = MAX_RESEARCH_CHARS_PER_PAGE) {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n[truncated ${s.length - max} chars]`;
}

function stripBase64ForPrompt(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.startsWith("data:image/")) return "[image data omitted]";
    return value.length > 6000 ? truncate(value, 6000) : value;
  }
  if (Array.isArray(value)) return value.slice(0, 20).map(stripBase64ForPrompt);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = stripBase64ForPrompt(v);
    }
    return out;
  }
  return value;
}

function clientImagePlaceholder(id: string) {
  return `__CLIENT_IMAGE_${id}__`;
}

function cleanString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanFormRequirement(value: unknown): FormRequirement {
  return value === "contact" ||
    value === "quote" ||
    value === "booking" ||
    value === "newsletter" ||
    value === "custom"
    ? value
    : "none";
}

function formRequirementLabel(value: FormRequirement) {
  switch (value) {
    case "contact":
      return "Contact form";
    case "quote":
      return "Quote request form";
    case "booking":
      return "Booking inquiry form";
    case "newsletter":
      return "Newsletter signup";
    case "custom":
      return "Custom form";
    case "none":
    default:
      return "No custom form";
  }
}

function extractJson(text: string): unknown {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {}

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {}
  }

  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(trimmed.slice(first, last + 1));
    } catch {}
  }

  throw new Error("Model response was not valid JSON");
}

function parseMarkdownMockups(text: string): Mockup[] | null {
  const fenceRegex = /(?:~~~|```)(?:html)?\s*\n([\s\S]*?)\n(?:~~~|```)/g;
  const blocks: { html: string; index: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = fenceRegex.exec(text)) !== null) {
    const html = m[1].trim();
    if (html.length > 0) blocks.push({ html, index: m.index });
  }
  if (blocks.length !== 3) return null;

  return blocks.map((block, i) => {
    const sliceStart = i === 0 ? 0 : blocks[i - 1].index;
    const headerSearch = text.slice(sliceStart, block.index);
    const headerMatch = headerSearch.match(/##\s+([A-Z][A-Za-z0-9 _-]*[A-Za-z0-9])/);
    return {
      name: headerMatch?.[1]?.trim() || `Design ${String.fromCharCode(65 + i)}`,
      html: block.html,
    };
  });
}

function isValidMockups(value: unknown): value is { mockups: Mockup[] } {
  if (!value || typeof value !== "object") return false;
  const mockups = (value as { mockups?: unknown }).mockups;
  return (
    Array.isArray(mockups) &&
    mockups.length === 3 &&
    mockups.every(
      (m) =>
        m &&
        typeof m === "object" &&
        typeof (m as Mockup).name === "string" &&
        typeof (m as Mockup).html === "string" &&
        (m as Mockup).html.trim().startsWith("<!DOCTYPE html"),
    )
  );
}

function parseMockupsFromText(text: string): Mockup[] {
  const markdown = parseMarkdownMockups(text);
  if (markdown) return markdown;
  const parsed = extractJson(text);
  if (isValidMockups(parsed)) return parsed.mockups;
  throw new Error("Model response did not include three valid HTML mockups");
}

function parseClientImages(value: unknown): ClientImageAsset[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("Client images must be an array");
  if (value.length > MAX_CLIENT_IMAGES) {
    throw new Error(`Provide at most ${MAX_CLIENT_IMAGES} client images`);
  }

  let totalBytes = 0;
  return value.map((item, index) => {
    if (!item || typeof item !== "object") {
      throw new Error("Each client image must be an object");
    }
    const v = item as Record<string, unknown>;
    const id = typeof v.id === "string" && /^[A-Za-z0-9_-]{1,48}$/.test(v.id)
      ? v.id
      : `asset_${index + 1}`;
    const name = typeof v.name === "string" && v.name.trim() ? v.name.trim().slice(0, 120) : `Client image ${index + 1}`;
    const role = v.role === "hero" || v.role === "services" || v.role === "team" || v.role === "gallery" || v.role === "general"
      ? v.role
      : "general";
    if (typeof v.dataUrl !== "string" || !parseImageDataUrl(v.dataUrl)) {
      throw new Error(`${name} must be a PNG, JPEG, GIF, or WEBP data URL`);
    }
    if (v.dataUrl.length > MAX_CLIENT_IMAGE_DATA_URL_BYTES) {
      throw new Error(`${name} is still too large after compression`);
    }
    totalBytes += v.dataUrl.length;
    if (totalBytes > MAX_TOTAL_CLIENT_IMAGE_BYTES) {
      throw new Error("Client images are too large in total");
    }
    return { id, name, role, dataUrl: v.dataUrl };
  });
}

function buildResearchSummary(packet: ResearchPacket) {
  const pages = [packet.currentSite, ...packet.inspirations].filter(Boolean) as ResearchPage[];
  return pages
    .map((p) => {
      const status = p.error ? `FAILED: ${p.error}` : `${p.markdown.length} chars`;
      return `${p.kind.toUpperCase()} ${p.url} (${p.source}) ${status}`;
    })
    .join("\n");
}

async function scrapeFirecrawl(
  url: string,
  kind: "current" | "inspiration",
  options?: { deadlineAt?: number; signal?: AbortSignal },
): Promise<ResearchPage> {
  const apiKey = process.env.FIRECRAWL_API_KEY;
  if (!apiKey) {
    return {
      url,
      kind,
      source: "provider-tools",
      markdown: "",
      links: [],
      images: [],
      branding: null,
      error: "FIRECRAWL_API_KEY not configured",
    };
  }

  const controller = new AbortController();
  const forwardAbort = () => controller.abort(options?.signal?.reason);
  if (options?.signal?.aborted) forwardAbort();
  options?.signal?.addEventListener("abort", forwardAbort, { once: true });
  const remainingMs = options?.deadlineAt
    ? options.deadlineAt - Date.now()
    : 65_000;
  if (remainingMs <= 0) {
    options?.signal?.removeEventListener("abort", forwardAbort);
    throw new Error("Generation reached the route work deadline");
  }
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1, Math.min(65_000, remainingMs)),
  );

  try {
    const res = await fetch("https://api.firecrawl.dev/v2/scrape", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        url,
        formats:
          kind === "current"
            ? ["markdown", "screenshot", "links", "images", "branding"]
            : ["markdown", "screenshot", "branding"],
        onlyMainContent: true,
        removeBase64Images: true,
        blockAds: true,
        proxy: "auto",
        timeout: 60000,
      }),
      signal: controller.signal,
    });

    const json = (await res.json().catch(() => null)) as {
      success?: boolean;
      data?: Record<string, unknown>;
      error?: string;
    } | null;
    if (!res.ok || !json?.success || !json.data) {
      throw new Error(json?.error || `Firecrawl error (${res.status})`);
    }
    const data = json.data;
    return {
      url,
      kind,
      source: "firecrawl",
      markdown: truncate(typeof data.markdown === "string" ? data.markdown : ""),
      screenshotDataUrl: typeof data.screenshot === "string" && data.screenshot.startsWith("data:image/")
        ? data.screenshot
        : undefined,
      links: Array.isArray(data.links) ? data.links.filter((x): x is string => typeof x === "string").slice(0, 30) : [],
      images: Array.isArray(data.images) ? data.images.filter((x): x is string => typeof x === "string").slice(0, 30) : [],
      branding: data.branding ?? null,
    };
  } catch (err) {
    if (options?.signal?.aborted) throw err;
    if (options?.deadlineAt && Date.now() >= options.deadlineAt) {
      throw new Error("Generation reached the route work deadline", {
        cause: err,
      });
    }
    return {
      url,
      kind,
      source: "provider-tools",
      markdown: "",
      links: [],
      images: [],
      branding: null,
      error: err instanceof Error ? err.message : "Firecrawl scrape failed",
    };
  } finally {
    clearTimeout(timeout);
    options?.signal?.removeEventListener("abort", forwardAbort);
  }
}

async function buildResearchPacket(
  currentSite: string,
  urls: string[],
  options?: { deadlineAt?: number; signal?: AbortSignal },
): Promise<ResearchPacket> {
  const pages = await Promise.all([
    currentSite
      ? scrapeFirecrawl(currentSite, "current", options)
      : Promise.resolve(undefined),
    ...urls.map((url) => scrapeFirecrawl(url, "inspiration", options)),
  ]);
  const current = pages[0] as ResearchPage | undefined;
  const inspirations = pages.slice(1).filter((p): p is ResearchPage => Boolean(p));
  const all = [current, ...inspirations].filter(Boolean) as ResearchPage[];
  const firecrawlCount = all.filter((p) => p.source === "firecrawl").length;
  const source =
    firecrawlCount === all.length && all.length > 0
      ? "firecrawl"
      : firecrawlCount > 0
        ? "mixed"
        : "provider-tools";
  return { currentSite: current, inspirations, source };
}

function firecrawlScreenshotInputs(packet: ResearchPacket): ParsedImage[] {
  return [packet.currentSite, ...packet.inspirations]
    .filter(Boolean)
    .flatMap((p) => {
      const screenshot = (p as ResearchPage).screenshotDataUrl;
      const parsed = screenshot ? parseImageDataUrl(screenshot) : null;
      return parsed ? [{ ...parsed, label: `${(p as ResearchPage).kind} screenshot: ${(p as ResearchPage).url}` }] : [];
    })
    .slice(0, 4);
}

async function generateWithOpenAI(args: {
  apiKey: string;
  prompt: string;
  images?: ParsedImage[];
  useWebSearch?: boolean;
  maxOutputTokens?: number;
  deadlineAt?: number;
  signal?: AbortSignal;
}) {
  const { model, reasoningEffort, reasoningMode, serviceTier } =
    getOpenAIMockupConfig();
  const content = [
    ...(args.images ?? []).map((s) => ({
      type: "input_image",
      image_url: `data:${s.mediaType};base64,${s.base64}`,
      detail: "auto",
    })),
    { type: "input_text", text: args.prompt },
  ];

  const body: Record<string, unknown> = {
    model,
    input: [{ role: "user", content }],
    max_output_tokens: args.maxOutputTokens ?? MODEL_OUTPUT_TOKENS.mockups,
    reasoning: { effort: reasoningEffort, mode: reasoningMode },
    service_tier: serviceTier,
    store: false,
  };
  if (args.useWebSearch) {
    body.tools = [{ type: "web_search", search_context_size: "medium" }];
    body.max_tool_calls = 8;
  }

  const json = await createAndPollOpenAIResponse({
    apiKey: args.apiKey,
    body,
    deadlineAt: args.deadlineAt,
    signal: args.signal,
  });
  return extractOpenAIText(json);
}

async function generateWithAnthropic(args: {
  apiKey: string;
  prompt: string;
  images?: ParsedImage[];
  useWebFetch?: boolean;
  maxTokens?: number;
}) {
  const { model, reasoningEffort } = getAnthropicMockupConfig();
  const client = new Anthropic({ apiKey: args.apiKey });
  const content = [
    ...(args.images ?? []).map((s) => ({
      type: "image",
      source: { type: "base64", media_type: s.mediaType, data: s.base64 },
    })),
    { type: "text", text: args.prompt },
  ];

  const messages: Array<Record<string, unknown>> = [
    { role: "user", content },
  ];
  const request: Record<string, unknown> = {
    model,
    max_tokens: args.maxTokens ?? MODEL_OUTPUT_TOKENS.mockups,
    output_config: { effort: reasoningEffort },
    messages,
  };
  if (args.useWebFetch) {
    request.betas = ["web-fetch-2025-09-10"];
    request.tools = [
      {
        type: "web_fetch_20250910",
        name: "web_fetch",
        max_uses: 8,
        max_content_tokens: 12000,
      },
    ];
  }

  let stream = client.beta.messages.stream(request as never);
  let response = await stream.finalMessage();
  let pauseContinuations = 0;
  while (
    response.stop_reason === "pause_turn" &&
    pauseContinuations < MAX_ANTHROPIC_PAUSE_CONTINUATIONS
  ) {
    pauseContinuations += 1;
    messages.splice(
      0,
      messages.length,
      { role: "user", content },
      { role: "assistant", content: response.content },
    );
    console.log("[generate] continuing paused Anthropic server-tool turn", {
      continuation: pauseContinuations,
    });
    stream = client.beta.messages.stream({ ...request, messages } as never);
    response = await stream.finalMessage();
  }
  assertAnthropicResponseComplete(response);
  const text = response.content
    .filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("Anthropic returned no text content");
  return text;
}

async function generateModelText(args: {
  provider: GenerationProvider;
  apiKey: string;
  prompt: string;
  images?: ParsedImage[];
  useProviderTools?: boolean;
  maxTokens?: number;
  deadlineAt?: number;
  signal?: AbortSignal;
}) {
  if (args.provider === "openai") {
    return generateWithOpenAI({
      apiKey: args.apiKey,
      prompt: args.prompt,
      images: args.images,
      useWebSearch: args.useProviderTools,
      maxOutputTokens: args.maxTokens,
      deadlineAt: args.deadlineAt,
      signal: args.signal,
    });
  }
  return generateWithAnthropic({
    apiKey: args.apiKey,
    prompt: args.prompt,
    images: args.images,
    useWebFetch: args.useProviderTools,
    maxTokens: args.maxTokens,
  });
}

function buildAnalysisPrompt(args: {
  clientName: string;
  currentSite: string;
  urls: string[];
  brandColor: string;
  research: ResearchPacket;
  projectBrief: string;
  audience: string;
  goals: string;
  mustHaves: string;
  formRequirement: FormRequirement;
  formDetails: string;
  avoidList: string;
  compNotes: string;
  styleNotes: string;
  imageAssets: ClientImageAsset[];
}) {
  const researchForPrompt = stripBase64ForPrompt(args.research);
  return `You are a senior brand strategist and web art director. Create the strategy packet for 3 premium homepage mockups for ${args.clientName}.

Return ONLY JSON with this exact shape:
{
  "brandProfile": "concise brand truth, services/products, voice, audience, factual constraints",
  "inspirationProfile": "visual inspiration synthesis: palette, typography, imagery, layout DNA, comp URL roles",
  "directions": [
    { "name": "Design A name", "angle": "...", "palette": "...", "typography": "...", "layout": "...", "imagery": "..." },
    { "name": "Design B name", "angle": "...", "palette": "...", "typography": "...", "layout": "...", "imagery": "..." },
    { "name": "Design C name", "angle": "...", "palette": "...", "typography": "...", "layout": "...", "imagery": "..." }
  ]
}

Canonical client website: ${args.currentSite || "(none provided)"}
Inspiration URLs: ${args.urls.join(", ") || "(none provided)"}
Brand color hints: ${args.brandColor || "designer's choice"}
Project brief: ${args.projectBrief || "(none)"}
Audience: ${args.audience || "(infer from client site and brief)"}
Goals: ${args.goals || "(infer)"}
Must-haves: ${args.mustHaves || "(none)"}
Form requirement: ${formRequirementLabel(args.formRequirement)}
Form details: ${args.formRequirement === "none" ? "(none)" : args.formDetails || "(use sensible default fields for this form type)"}
Avoid: ${args.avoidList || "(none)"}
Comp usage notes: ${args.compNotes || "(none)"}
Style notes: ${args.styleNotes || "(none)"}
Client image assets available: ${args.imageAssets.map((img) => `${clientImagePlaceholder(img.id)} = ${img.name} (${img.role})`).join("; ") || "(none)"}

Research packet:
${JSON.stringify(researchForPrompt, null, 2)}

Rules:
- Treat the current site as brand truth when present.
- Inspiration sites are visual direction only unless the user explicitly says otherwise.
- If the form requirement is not "No custom form", make the form a deliberate conversion element in the strategy. If it is "No custom form", do not create form-based concepts just because a site has contact CTAs.
- Do not invent facts that conflict with research.
- The 3 directions must be visibly different, premium, and practical to render as standalone Tailwind HTML.`;
}

function fallbackAnalysis(clientName: string): DesignAnalysis {
  return {
    brandProfile: `${clientName} brand profile could not be parsed from the strategy response. Use the provided brief, current site, and assets as the source of truth.`,
    inspirationProfile: "Use the provided screenshots, Firecrawl research, and inspiration URLs for palette, typography, imagery, and layout direction.",
    directions: [
      {
        name: "Design A",
        angle: "Premium editorial homepage with strong hero storytelling.",
        palette: "Brand-led palette with one confident accent.",
        typography: "Elegant display headings with readable sans-serif body copy.",
        layout: "Asymmetric hero, rich service cards, proof-forward CTA.",
        imagery: "Use client photos prominently and crop them intentionally.",
      },
      {
        name: "Design B",
        angle: "Conversion-focused modern homepage.",
        palette: "Clean surfaces, high contrast CTAs, restrained accent use.",
        typography: "Bold sans-serif hierarchy.",
        layout: "Clear hero, benefits grid, testimonial band, direct booking/contact CTA.",
        imagery: "Use client photos as trust-building proof.",
      },
      {
        name: "Design C",
        angle: "Distinctive brand-forward concept.",
        palette: "More expressive interpretation of the brand colors.",
        typography: "Mix confident heading scale with warm body copy.",
        layout: "Immersive hero, gallery/service rhythm, memorable footer CTA.",
        imagery: "Use the strongest real client images as primary design material.",
      },
    ],
  };
}

function parseAnalysis(text: string, clientName: string): DesignAnalysis {
  try {
    const parsed = extractJson(text) as Partial<DesignAnalysis>;
    const directions = Array.isArray(parsed.directions) ? parsed.directions.slice(0, 3) : [];
    if (typeof parsed.brandProfile === "string" && directions.length === 3) {
      return {
        brandProfile: parsed.brandProfile,
        inspirationProfile: typeof parsed.inspirationProfile === "string" ? parsed.inspirationProfile : "",
        directions: directions.map((d, i) => ({
          name: typeof d.name === "string" ? d.name : `Design ${String.fromCharCode(65 + i)}`,
          angle: typeof d.angle === "string" ? d.angle : "",
          palette: typeof d.palette === "string" ? d.palette : "",
          typography: typeof d.typography === "string" ? d.typography : "",
          layout: typeof d.layout === "string" ? d.layout : "",
          imagery: typeof d.imagery === "string" ? d.imagery : "",
        })),
      };
    }
  } catch {}
  return fallbackAnalysis(clientName);
}

function buildHtmlPrompt(args: {
  clientName: string;
  brandColor: string;
  logoBackground: LogoBackground;
  projectBrief: string;
  formRequirement: FormRequirement;
  formDetails: string;
  heroDirection: string;
  analysis: DesignAnalysis;
  imageAssets: ClientImageAsset[];
  research: ResearchPacket;
  usedProviderTools: boolean;
}) {
  const imageList = args.imageAssets
    .map((img) => `- ${clientImagePlaceholder(img.id)}: ${img.name}, role=${img.role}`)
    .join("\n");
  const currentSite = args.research.currentSite?.url || "";
  const inspirationUrls = args.research.inspirations.map((p) => p.url).join(", ");
  const providerToolInstruction = args.usedProviderTools
    ? "Use your web tool on the current site and inspiration URLs before writing if Firecrawl research is empty or failed."
    : "Do not browse unless needed; the research packet below is the shared source of truth.";
  const formInstruction =
    args.formRequirement === "none"
      ? "Do not include a custom form in the mockups. Use CTA buttons or contact links instead."
      : `Each mockup must include a polished ${formRequirementLabel(args.formRequirement).toLowerCase()} section with real form controls. Use these requested fields/details: ${args.formDetails || "use sensible default fields for this form type"}. Give fields practical name attributes, include a hidden honeypot input named website, and make the form visually integrated with the design.`;

  return `You are a senior web designer creating 3 state-of-the-art homepage mockups for ${args.clientName}.

${providerToolInstruction}

BRAND PROFILE:
${args.analysis.brandProfile}

INSPIRATION PROFILE:
${args.analysis.inspirationProfile}

CREATIVE DIRECTIONS:
${JSON.stringify(args.analysis.directions, null, 2)}

CLIENT CURRENT SITE: ${currentSite || "(none)"}
INSPIRATION URLS: ${inspirationUrls || "(none)"}
BRAND COLOR HINTS: ${args.brandColor || "designer's choice"}
PROJECT BRIEF: ${args.projectBrief || "(none)"}
FORM REQUIREMENT: ${formRequirementLabel(args.formRequirement)}
FORM DETAILS: ${args.formRequirement === "none" ? "(none)" : args.formDetails || "(use sensible default fields for this form type)"}
HERO DIRECTION: ${args.heroDirection || "(none)"}

LOGO PLACEHOLDER:
Use exactly ${LOGO_PLACEHOLDER} anywhere the logo appears.

CLIENT IMAGE PLACEHOLDERS:
${imageList || "(none)"}

Client image rules:
- If a hero-role image exists, use it in the hero of all 3 mockups.
- Use service-role images in service/product cards when available.
- Use team-role images in a team/trust section when available.
- Use gallery-role images in gallery or proof sections.
- General images may be used where they strengthen authenticity.
- Never invent data URLs; only use placeholders exactly as written.
- Use descriptive alt text.

Logo background constraint:
${args.logoBackground === "either" ? "Choose whatever header background best fits each design." : `The logo works best on ${args.logoBackground} backgrounds. Ensure it stays visible in every design.`}

Form constraint:
${formInstruction}

For each of the 3 mockups:
- Make a complete standalone HTML file with <!DOCTYPE html>, <html>, <head>, and <body>.
- Include <meta name="viewport" content="width=device-width, initial-scale=1">.
- Use Tailwind CSS via CDN.
- Include a header with prominent logo, hero, services/features or brief-specific primary section, social proof/testimonials, CTA, and footer.
- Make each mockup visually distinct and tied to one creative direction.
- Use real-looking client-relevant copy; no lorem ipsum.
- Make it premium and polished, not a wireframe.
- Fully responsive at 375px, 768px, and 1280px+. No horizontal scroll.
- Mobile header must include constrained logo, hamburger icon, hidden desktop nav, and a real JS-powered collapsible nav.
- Keep each HTML focused; target under 14,000 characters per mockup.

OUTPUT FORMAT:
Return EXACTLY three Markdown code blocks, each preceded by a Design header, using tilde fences:
## Design A
~~~html
<!DOCTYPE html>
...
</html>
~~~

## Design B
~~~html
...
~~~

## Design C
~~~html
...
~~~

The first line must be ## Design A. No prose before, between, or after.`;
}

function injectUploadedAssets(rawMockups: Mockup[], logoDataUrl: string, imageAssets: ClientImageAsset[], legacyHeroPhoto: string | null) {
  return rawMockups.map((m) => {
    let html = m.html.split(LOGO_PLACEHOLDER).join(logoDataUrl);
    if (legacyHeroPhoto) {
      html = html.split(HERO_IMAGE_PLACEHOLDER).join(legacyHeroPhoto);
    }
    for (const image of imageAssets) {
      html = html.split(clientImagePlaceholder(image.id)).join(image.dataUrl);
    }
    return { name: m.name, html };
  });
}

function countPlaceholderUses(rawMockup: Mockup, imageAssets: ClientImageAsset[]) {
  return {
    logo: rawMockup.html.split(LOGO_PLACEHOLDER).length - 1,
    clientImages: imageAssets.reduce<Record<string, number>>((acc, img) => {
      acc[img.id] = rawMockup.html.split(clientImagePlaceholder(img.id)).length - 1;
      return acc;
    }, {}),
  };
}

function localQa(raw: Mockup, imageAssets: ClientImageAsset[]): MockupQAReport {
  const issues: string[] = [];
  if (!raw.html.includes(LOGO_PLACEHOLDER)) issues.push("Logo placeholder is missing.");
  if (!/viewport/i.test(raw.html)) issues.push("Viewport meta tag may be missing.");
  if (!/hamburger|aria-label=["']?(open|toggle|menu)|<button[\s\S]{0,200}(span|svg)/i.test(raw.html)) {
    issues.push("Mobile hamburger/menu button is not obvious.");
  }
  const heroAssets = imageAssets.filter((img) => img.role === "hero");
  if (heroAssets.length > 0 && !heroAssets.some((img) => raw.html.includes(clientImagePlaceholder(img.id)))) {
    issues.push("No hero-role client image placeholder was used.");
  }
  if (raw.html.length > 24000) issues.push("HTML is unusually large and may be slow or bloated.");
  return {
    name: raw.name,
    pass: issues.length === 0,
    score: Math.max(60, 95 - issues.length * 12),
    issues,
    repairInstructions: issues.join(" "),
  };
}

async function renderMockupScreenshots(
  html: string,
  options?: { deadlineAt?: number; signal?: AbortSignal },
) {
  if (options?.signal?.aborted) {
    throw new Error("Generation request was cancelled");
  }
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      const shots: ParsedImage[] = [];
      for (const viewport of [
        { width: 375, height: 900, label: "mobile 375px" },
        { width: 768, height: 1000, label: "tablet 768px" },
        { width: 1280, height: 900, label: "desktop 1280px" },
      ]) {
        const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } });
        try {
          if (options?.signal?.aborted) {
            throw new Error("Generation request was cancelled");
          }
          const remainingMs = options?.deadlineAt
            ? options.deadlineAt - Date.now()
            : 30_000;
          if (remainingMs <= 0) {
            throw new Error("Generation reached the route work deadline");
          }
          await page.setContent(html, {
            waitUntil: "networkidle",
            timeout: Math.max(1, Math.min(30_000, remainingMs)),
          });
          const buffer = await page.screenshot({ fullPage: false, type: "png" });
          shots.push({ mediaType: "image/png", base64: buffer.toString("base64"), label: viewport.label });
        } finally {
          await page.close().catch(() => undefined);
        }
      }
      return shots;
    } finally {
      await browser.close().catch(() => undefined);
    }
  } catch (err) {
    if (options?.signal?.aborted) throw err;
    console.warn("[generate] Playwright render QA skipped", err);
    return [];
  }
}

function buildQaPrompt(mockupName: string, localReport: MockupQAReport) {
  return `You are a meticulous senior design QA reviewer. Review the rendered screenshots of ${mockupName}.

Return ONLY JSON:
{
  "pass": true,
  "score": 0,
  "issues": ["..."],
  "repairInstructions": "specific instructions to fix the HTML if needed"
}

Judge:
- premium visual quality
- no horizontal overflow at mobile/tablet/desktop
- logo visible and appropriately sized
- mobile nav appears usable
- client images are used authentically
- spacing, typography, and CTA hierarchy look polished

Local static checks already found:
${localReport.issues.length ? localReport.issues.join("\n") : "No static issues."}`;
}

function parseQa(text: string, fallback: MockupQAReport): MockupQAReport {
  try {
    const parsed = extractJson(text) as Partial<MockupQAReport>;
    const issues = Array.isArray(parsed.issues)
      ? parsed.issues.filter((x): x is string => typeof x === "string")
      : fallback.issues;
    return {
      name: fallback.name,
      pass: typeof parsed.pass === "boolean" ? parsed.pass && issues.length === 0 : fallback.pass,
      score: typeof parsed.score === "number" ? Math.max(0, Math.min(100, parsed.score)) : fallback.score,
      issues,
      repairInstructions:
        typeof parsed.repairInstructions === "string"
          ? parsed.repairInstructions
          : fallback.repairInstructions,
    };
  } catch {
    return fallback;
  }
}

async function qaMockup(args: {
  provider: GenerationProvider;
  apiKey: string;
  raw: Mockup;
  injected: Mockup;
  imageAssets: ClientImageAsset[];
  deadlineAt?: number;
  signal?: AbortSignal;
}) {
  const local = localQa(args.raw, args.imageAssets);
  if (args.signal?.aborted) {
    throw new Error("Generation request was cancelled");
  }
  if (
    args.deadlineAt &&
    args.deadlineAt - Date.now() < MIN_QA_RENDER_BUDGET_MS
  ) {
    console.warn("[generate] model QA skipped to preserve route deadline", {
      mockup: args.raw.name,
    });
    return local;
  }
  const rendered = await renderMockupScreenshots(args.injected.html, {
    deadlineAt: args.deadlineAt,
    signal: args.signal,
  });
  if (rendered.length === 0) return local;

  try {
    const text = await generateModelText({
      provider: args.provider,
      apiKey: args.apiKey,
      prompt: buildQaPrompt(args.raw.name, local),
      images: rendered,
      maxTokens: MODEL_OUTPUT_TOKENS.qa,
      deadlineAt: args.deadlineAt,
      signal: args.signal,
    });
    const qa = parseQa(text, local);
    if (!local.pass) {
      return {
        ...qa,
        pass: false,
        issues: Array.from(new Set([...local.issues, ...qa.issues])),
        repairInstructions: [local.repairInstructions, qa.repairInstructions].filter(Boolean).join(" "),
      };
    }
    return qa;
  } catch (err) {
    if (args.signal?.aborted) throw err;
    console.warn("[generate] model QA failed", err);
    return local;
  }
}

function buildRepairPrompt(args: {
  raw: Mockup;
  qa: MockupQAReport;
  imageAssets: ClientImageAsset[];
  logoBackground: LogoBackground;
}) {
  return `Repair this standalone HTML mockup. Return ONLY one html fenced code block. Preserve the visual direction, copy, logo placeholder, and client image placeholders.

QA issues:
${args.qa.issues.join("\n")}

Repair instructions:
${args.qa.repairInstructions}

Required placeholders:
- ${LOGO_PLACEHOLDER}
${args.imageAssets.map((img) => `- ${clientImagePlaceholder(img.id)} (${img.role})`).join("\n")}

Logo background: ${args.logoBackground}

HTML:
~~~html
${args.raw.html}
~~~`;
}

function parseSingleHtmlBlock(text: string, fallback: Mockup) {
  const match = text.match(/(?:~~~|```)(?:html)?\s*\n([\s\S]*?)\n(?:~~~|```)/);
  const html = match?.[1]?.trim();
  if (html && html.startsWith("<!DOCTYPE html")) return { ...fallback, html };
  return fallback;
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  const routeWorkDeadlineAt = startedAt + ROUTE_WORK_DEADLINE_MS;
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return badRequest("Request body must be JSON");
  }

  const urls = body.urls;
  if (!Array.isArray(urls) || !urls.every((u) => typeof u === "string")) {
    return badRequest("Inspiration URLs must be an array of strings");
  }
  const cleanedUrls = urls.map((u) => u.trim()).filter(Boolean).slice(0, 3);
  if (cleanedUrls.length === 0) return badRequest("Provide at least one inspiration URL");

  const logoDataUrl = body.logoDataUrl;
  if (typeof logoDataUrl !== "string" || !parseImageDataUrl(logoDataUrl)) {
    return badRequest("Logo must be uploaded as an image data URL");
  }
  if (logoDataUrl.length > MAX_LOGO_DATA_URL_BYTES) {
    return badRequest("Logo is too large; upload a smaller image");
  }

  const clientName = cleanString(body.clientName);
  if (!clientName) return badRequest("Client name is required");

  const provider: GenerationProvider = body.generationProvider === "anthropic" ? "anthropic" : "openai";
  const modelConfig =
    provider === "openai"
      ? getOpenAIMockupConfig()
      : getAnthropicMockupConfig();
  const apiKey = provider === "openai" ? process.env.OPENAI_API_KEY : process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: provider === "openai" ? "Server is missing OPENAI_API_KEY" : "Server is missing ANTHROPIC_API_KEY" },
      { status: 500 },
    );
  }

  let clientImages: ClientImageAsset[];
  try {
    clientImages = parseClientImages(body.clientImages);
  } catch (err) {
    return badRequest(err instanceof Error ? err.message : "Invalid client images");
  }

  let legacyHeroPhoto: string | null = null;
  if (typeof body.heroPhotoDataUrl === "string" && body.heroPhotoDataUrl.trim()) {
    if (!parseImageDataUrl(body.heroPhotoDataUrl)) {
      return badRequest("Hero photo must be an image data URL");
    }
    if (body.heroPhotoDataUrl.length > MAX_CLIENT_IMAGE_DATA_URL_BYTES) {
      return badRequest("Hero photo is too large; upload it through the compressed client image library");
    }
    legacyHeroPhoto = body.heroPhotoDataUrl;
    if (!clientImages.some((img) => img.role === "hero")) {
      clientImages = [
        {
          id: "legacy_hero",
          name: "Hero photo",
          role: "hero" as const,
          dataUrl: body.heroPhotoDataUrl,
        },
        ...clientImages,
      ].slice(0, MAX_CLIENT_IMAGES);
    }
  }

  const parsedScreenshots: ParsedImage[] = [];
  if (body.screenshots !== undefined) {
    if (!Array.isArray(body.screenshots) || !body.screenshots.every((s) => typeof s === "string")) {
      return badRequest("Screenshots must be an array of image data URL strings");
    }
    if (body.screenshots.length > MAX_SCREENSHOTS) return badRequest(`Provide at most ${MAX_SCREENSHOTS} screenshots`);
    for (const dataUrl of body.screenshots as string[]) {
      if (dataUrl.length > MAX_SCREENSHOT_DATA_URL_BYTES) return badRequest("One screenshot is too large");
      const parsed = parseImageDataUrl(dataUrl);
      if (!parsed) return badRequest("Screenshots must be PNG, JPEG, GIF, or WEBP data URLs");
      parsedScreenshots.push(parsed);
    }
  }

  const currentSite = cleanString(body.currentSite);
  const brandColor = cleanString(body.brandColor);
  const projectBrief = cleanString(body.projectBrief);
  const formRequirement = cleanFormRequirement(body.formRequirement);
  const formDetails = cleanString(body.formDetails);
  const heroDirection = cleanString(body.heroDirection);
  const logoBackground: LogoBackground =
    body.logoBackground === "light" || body.logoBackground === "dark" ? body.logoBackground : "either";
  const qualityMode: QualityMode = "premium";

  console.log("[generate] premium request received", {
    provider,
    model: modelConfig.model,
    reasoningEffort: modelConfig.reasoningEffort,
    reasoningMode:
      "reasoningMode" in modelConfig ? modelConfig.reasoningMode : undefined,
    serviceTier:
      "serviceTier" in modelConfig ? modelConfig.serviceTier : undefined,
    clientName,
    currentSite: currentSite || null,
    inspirationUrls: cleanedUrls.length,
    screenshots: parsedScreenshots.length,
    clientImages: clientImages.length,
    formRequirement,
    qualityMode,
  });

  try {
    console.log("[generate] stage=research");
    const research = await buildResearchPacket(currentSite, cleanedUrls, {
      deadlineAt: routeWorkDeadlineAt,
      signal: req.signal,
    });
    const useProviderTools = research.source !== "firecrawl";
    const researchImages = firecrawlScreenshotInputs(research);

    console.log("[generate] stage=directions", {
      researchSource: research.source,
      firecrawlScreenshots: researchImages.length,
    });
    const analysisPrompt = buildAnalysisPrompt({
      clientName,
      currentSite,
      urls: cleanedUrls,
      brandColor,
      research,
      projectBrief,
      audience: cleanString(body.audience),
      goals: cleanString(body.goals),
      mustHaves: cleanString(body.mustHaves),
      formRequirement,
      formDetails,
      avoidList: cleanString(body.avoidList),
      compNotes: cleanString(body.compNotes),
      styleNotes: cleanString(body.styleNotes),
      imageAssets: clientImages,
    });
    const analysisText = await generateModelText({
      provider,
      apiKey,
      prompt: analysisPrompt,
      images: [...parsedScreenshots, ...researchImages].slice(0, 7),
      useProviderTools,
      maxTokens: MODEL_OUTPUT_TOKENS.directions,
      deadlineAt: routeWorkDeadlineAt,
      signal: req.signal,
    });
    const analysis = parseAnalysis(analysisText, clientName);

    console.log("[generate] stage=html", {
      directions: analysis.directions.map((d) => d.name),
    });
    const htmlPrompt = buildHtmlPrompt({
      clientName,
      brandColor,
      logoBackground,
      projectBrief,
      formRequirement,
      formDetails,
      heroDirection,
      analysis,
      imageAssets: clientImages,
      research,
      usedProviderTools: useProviderTools,
    });
    const htmlText = await generateModelText({
      provider,
      apiKey,
      prompt: htmlPrompt,
      images: [...parsedScreenshots, ...researchImages].slice(0, 7),
      useProviderTools,
      maxTokens: MODEL_OUTPUT_TOKENS.mockups,
      deadlineAt: routeWorkDeadlineAt,
      signal: req.signal,
    });
    const rawMockups = parseMockupsFromText(htmlText);
    let injectedMockups = injectUploadedAssets(rawMockups, logoDataUrl, clientImages, legacyHeroPhoto);

    console.log("[generate] stage=qa");
    let qaReports = await Promise.all(
      rawMockups.map((raw, i) =>
        qaMockup({
          provider,
          apiKey,
          raw,
          injected: injectedMockups[i],
          imageAssets: clientImages,
          deadlineAt: routeWorkDeadlineAt,
          signal: req.signal,
        }),
      ),
    );

    const failingIndexes = qaReports
      .map((qa, i) => ({ qa, i }))
      .filter(({ qa }) => !qa.pass || qa.score < 82)
      .map(({ i }) => i);

    if (
      failingIndexes.length > 0 &&
      MAX_REPAIR_PASSES > 0 &&
      routeWorkDeadlineAt - Date.now() >= MIN_REPAIR_START_BUDGET_MS
    ) {
      console.log("[generate] stage=repair", { failingIndexes });
      let repairedAny = false;
      for (const i of failingIndexes) {
        try {
          const repairText = await generateModelText({
            provider,
            apiKey,
            prompt: buildRepairPrompt({
              raw: rawMockups[i],
              qa: qaReports[i],
              imageAssets: clientImages,
              logoBackground,
            }),
            maxTokens: MODEL_OUTPUT_TOKENS.repair,
            deadlineAt: routeWorkDeadlineAt,
            signal: req.signal,
          });
          rawMockups[i] = parseSingleHtmlBlock(repairText, rawMockups[i]);
          repairedAny = true;
        } catch (err) {
          if (req.signal.aborted) throw err;
          console.warn("[generate] repair skipped after model failure", {
            mockup: rawMockups[i].name,
            error: err instanceof Error ? err.message : String(err),
          });
          break;
        }
      }
      if (repairedAny) {
        injectedMockups = injectUploadedAssets(rawMockups, logoDataUrl, clientImages, legacyHeroPhoto);
        qaReports = await Promise.all(
          rawMockups.map((raw, i) =>
            qaMockup({
              provider,
              apiKey,
              raw,
              injected: injectedMockups[i],
              imageAssets: clientImages,
              deadlineAt: routeWorkDeadlineAt,
              signal: req.signal,
            }),
          ),
        );
      }
    } else if (failingIndexes.length > 0) {
      console.warn("[generate] repair skipped to preserve route deadline", {
        failingIndexes,
      });
    }

    const placeholderCounts = rawMockups.map((m) => countPlaceholderUses(m, clientImages));
    console.log("[generate] success", {
      provider,
      researchSource: research.source,
      mockups: injectedMockups.length,
      qaScores: qaReports.map((q) => q.score),
      placeholderCounts,
      elapsedSec: ((Date.now() - startedAt) / 1000).toFixed(1),
    });

    return NextResponse.json({
      mockups: injectedMockups,
      researchSummary: buildResearchSummary(research),
      directions: analysis.directions,
      qaReports,
      usedProvider: provider,
      usedModel: modelConfig.model,
      usedReasoningEffort: modelConfig.reasoningEffort,
      usedReasoningMode:
        "reasoningMode" in modelConfig ? modelConfig.reasoningMode : undefined,
      usedServiceTier:
        "serviceTier" in modelConfig ? modelConfig.serviceTier : undefined,
      usedResearchSource: research.source,
    });
  } catch (err) {
    console.error("[generate] failed after", ((Date.now() - startedAt) / 1000).toFixed(1), "s:", err);
    const message =
      err instanceof Anthropic.APIError
        ? `Anthropic API error: ${err.message}`
        : err instanceof Error
          ? err.message
          : "Mockup generation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
