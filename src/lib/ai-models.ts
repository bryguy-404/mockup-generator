export const DEFAULT_OPENAI_MODEL = "gpt-5.6-sol";
export const DEFAULT_ANTHROPIC_MODEL = "claude-fable-5";
export const DEFAULT_OPENAI_REASONING_EFFORT = "max";
export const DEFAULT_OPENAI_REASONING_MODE = "pro";
export const DEFAULT_OPENAI_SERVICE_TIER = "fast";
export const DEFAULT_ANTHROPIC_REASONING_EFFORT = "max";

export const MODEL_OUTPUT_TOKENS = {
  directions: 64_000,
  mockups: 128_000,
  qa: 64_000,
  repair: 128_000,
  refine: 128_000,
  export: 128_000,
} as const;

const OPENAI_REASONING_EFFORTS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
const OPENAI_REASONING_MODES = ["standard", "pro"] as const;
const OPENAI_SERVICE_TIERS = [
  "auto",
  "default",
  "flex",
  "fast",
  "priority",
] as const;
const ANTHROPIC_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type OpenAIReasoningEffort =
  (typeof OPENAI_REASONING_EFFORTS)[number];
export type OpenAIReasoningMode = (typeof OPENAI_REASONING_MODES)[number];
export type OpenAIServiceTier = (typeof OPENAI_SERVICE_TIERS)[number];
export type AnthropicReasoningEffort =
  (typeof ANTHROPIC_REASONING_EFFORTS)[number];

function readString(name: string, fallback: string) {
  return process.env[name]?.trim() || fallback;
}

function readChoice<const T extends readonly string[]>(
  name: string,
  values: T,
  fallback: T[number],
): T[number] {
  const value = process.env[name]?.trim();
  return value && values.includes(value) ? (value as T[number]) : fallback;
}

export function getOpenAIMockupConfig() {
  return {
    model: readString("OPENAI_MOCKUP_MODEL", DEFAULT_OPENAI_MODEL),
    reasoningEffort: readChoice(
      "OPENAI_REASONING_EFFORT",
      OPENAI_REASONING_EFFORTS,
      DEFAULT_OPENAI_REASONING_EFFORT,
    ),
    reasoningMode: readChoice(
      "OPENAI_REASONING_MODE",
      OPENAI_REASONING_MODES,
      DEFAULT_OPENAI_REASONING_MODE,
    ),
    serviceTier: readChoice(
      "OPENAI_SERVICE_TIER",
      OPENAI_SERVICE_TIERS,
      DEFAULT_OPENAI_SERVICE_TIER,
    ),
  };
}

export function getAnthropicMockupConfig() {
  return {
    model: readString("ANTHROPIC_MOCKUP_MODEL", DEFAULT_ANTHROPIC_MODEL),
    reasoningEffort: readChoice(
      "ANTHROPIC_REASONING_EFFORT",
      ANTHROPIC_REASONING_EFFORTS,
      DEFAULT_ANTHROPIC_REASONING_EFFORT,
    ),
  };
}

export function getAnthropicExportConfig() {
  return {
    model: readString("ANTHROPIC_EXPORT_MODEL", DEFAULT_ANTHROPIC_MODEL),
    reasoningEffort: readChoice(
      "ANTHROPIC_REASONING_EFFORT",
      ANTHROPIC_REASONING_EFFORTS,
      DEFAULT_ANTHROPIC_REASONING_EFFORT,
    ),
  };
}

type AnthropicCompletion = {
  stop_reason?: string | null;
  stop_details?: { explanation?: unknown } | null;
};

export function assertAnthropicResponseComplete(response: AnthropicCompletion) {
  if (response.stop_reason === "refusal") {
    const explanation = response.stop_details?.explanation;
    throw new Error(
      typeof explanation === "string" && explanation.trim()
        ? `Claude refused the request: ${explanation.trim()}`
        : "Claude refused the request",
    );
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error(
      "Claude reached its output limit before completing the response. Try the request again.",
    );
  }
  if (response.stop_reason === "model_context_window_exceeded") {
    throw new Error(
      "Claude reached its context-window limit before completing the response.",
    );
  }
  if (response.stop_reason === "pause_turn") {
    throw new Error(
      "Claude paused its server-tool turn too many times before completing the response.",
    );
  }
}

export function extractOpenAIText(value: unknown): string {
  if (!value || typeof value !== "object") {
    throw new Error("OpenAI response was not an object");
  }

  const response = value as {
    status?: unknown;
    incomplete_details?: { reason?: unknown } | null;
    error?: { message?: unknown } | null;
    output_text?: unknown;
    output?: unknown;
  };

  if (response.status === "incomplete") {
    const reason = response.incomplete_details?.reason;
    throw new Error(
      typeof reason === "string" && reason
        ? `OpenAI response was incomplete: ${reason}`
        : "OpenAI response was incomplete",
    );
  }
  if (response.status === "failed" || response.status === "cancelled") {
    const message = response.error?.message;
    throw new Error(
      typeof message === "string" && message
        ? `OpenAI response failed: ${message}`
        : `OpenAI response ${response.status}`,
    );
  }

  const parts: string[] = [];
  const refusals: string[] = [];
  if (Array.isArray(response.output)) {
    for (const item of response.output) {
      const content =
        item && typeof item === "object"
          ? (item as { content?: unknown }).content
          : null;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        const typedBlock = block as {
          type?: unknown;
          text?: unknown;
          refusal?: unknown;
        };
        if (
          typedBlock.type === "output_text" &&
          typeof typedBlock.text === "string"
        ) {
          parts.push(typedBlock.text);
        }
        if (
          typedBlock.type === "refusal" &&
          typeof typedBlock.refusal === "string"
        ) {
          refusals.push(typedBlock.refusal);
        }
      }
    }
  }

  if (refusals.length > 0) {
    throw new Error(`OpenAI refused the request: ${refusals.join(" ")}`);
  }
  if (typeof response.output_text === "string" && response.output_text.trim()) {
    return response.output_text.trim();
  }

  const text = parts.join("\n").trim();
  if (!text) throw new Error("OpenAI returned no text content");
  return text;
}
