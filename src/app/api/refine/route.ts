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

type GenerationProvider = "anthropic" | "openai";
type RequestBody = {
  html?: unknown;
  instruction?: unknown;
  clientName?: unknown;
  mockupName?: unknown;
  generationProvider?: unknown;
  projectBrief?: unknown;
  styleNotes?: unknown;
};
type RefineQAReport = {
  pass: boolean;
  issues: string[];
  checkedViewports: string[];
};

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

function protectDataUrls(html: string) {
  const assets: string[] = [];
  const protectedHtml = html.replace(
    /data:image\/[a-z+.-]+;base64,[A-Za-z0-9+/=]+/g,
    (match) => {
      const token = `__EMBEDDED_IMAGE_${assets.length}__`;
      assets.push(match);
      return token;
    },
  );
  return { protectedHtml, assets };
}

function restoreDataUrls(html: string, assets: string[]) {
  return assets.reduce(
    (next, dataUrl, index) =>
      next.split(`__EMBEDDED_IMAGE_${index}__`).join(dataUrl),
    html,
  );
}

function parseHtml(text: string, fallback: string) {
  const fence = text.match(/(?:~~~|```)(?:html)?\s*\n([\s\S]*?)\n(?:~~~|```)/);
  const fencedHtml = fence?.[1]?.trim();
  if (fencedHtml?.startsWith("<!DOCTYPE html")) return fencedHtml;

  const start = text.indexOf("<!DOCTYPE html");
  const end = text.lastIndexOf("</html>");
  if (start !== -1 && end !== -1 && end > start) {
    return text.slice(start, end + "</html>".length).trim();
  }

  return fallback;
}

async function callOpenAI(
  apiKey: string,
  prompt: string,
  signal: AbortSignal,
  deadlineAt: number,
) {
  const { model, reasoningEffort, reasoningMode, serviceTier } =
    getOpenAIMockupConfig();
  const json = await createAndPollOpenAIResponse({
    apiKey,
    body: {
      model,
      input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }],
      max_output_tokens: MODEL_OUTPUT_TOKENS.refine,
      reasoning: { effort: reasoningEffort, mode: reasoningMode },
      service_tier: serviceTier,
      store: false,
    },
    deadlineAt,
    signal,
  });
  return extractOpenAIText(json);
}

async function callAnthropic(apiKey: string, prompt: string) {
  const { model, reasoningEffort } = getAnthropicMockupConfig();
  const client = new Anthropic({ apiKey });
  const stream = client.messages.stream({
    model,
    max_tokens: MODEL_OUTPUT_TOKENS.refine,
    output_config: { effort: reasoningEffort },
    messages: [{ role: "user", content: prompt }],
  });
  const response = await stream.finalMessage();
  assertAnthropicResponseComplete(response);
  const text = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) throw new Error("Anthropic returned no text content");
  return text;
}

function buildPrompt(args: {
  clientName: string;
  mockupName: string;
  instruction: string;
  html: string;
  projectBrief: string;
  styleNotes: string;
}) {
  return `You are a senior web designer refining one generated homepage mockup for ${args.clientName}.

Target mockup: ${args.mockupName}
User edit request:
${args.instruction}

Project brief context:
${args.projectBrief || "(none provided)"}

Style notes:
${args.styleNotes || "(none provided)"}

Rules:
- Return one complete standalone HTML file only.
- Preserve the current concept unless the user explicitly asks to change it.
- Make the requested edit with production-quality visual polish.
- Keep all existing embedded image placeholder tokens exactly as written, such as __EMBEDDED_IMAGE_0__.
- Keep Tailwind CDN usage and any mobile nav JavaScript functional.
- Keep the viewport meta tag.
- Keep the mockup responsive at 375px, 768px, and desktop widths.
- Do not add explanations.

Return exactly one HTML code block using tilde fences:
~~~html
<!DOCTYPE html>
...
</html>
~~~

Current HTML:
~~~html
${args.html}
~~~`;
}

async function quickQa(
  html: string,
  options?: { deadlineAt?: number; signal?: AbortSignal },
): Promise<RefineQAReport> {
  const checkedViewports: string[] = [];
  const issues: string[] = [];
  if (!html.includes("<meta name=\"viewport\"")) {
    issues.push("Viewport meta tag may be missing.");
  }
  if (!/<button[\s\S]{0,500}(aria-label|span|svg)/i.test(html)) {
    issues.push("Mobile menu button is not obvious.");
  }
  if (options?.signal?.aborted) {
    throw new Error("Refinement request was cancelled");
  }
  if (options?.deadlineAt && options.deadlineAt - Date.now() < 5_000) {
    console.warn("[refine] Playwright QA skipped to preserve route deadline");
    return { pass: issues.length === 0, issues, checkedViewports };
  }

  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: true });
    try {
      for (const viewport of [
        { width: 375, height: 900, label: "375px" },
        { width: 768, height: 1000, label: "768px" },
        { width: 1280, height: 900, label: "1280px" },
      ]) {
        const page = await browser.newPage({
          viewport: { width: viewport.width, height: viewport.height },
        });
        try {
          if (options?.signal?.aborted) {
            throw new Error("Refinement request was cancelled");
          }
          const remainingMs = options?.deadlineAt
            ? options.deadlineAt - Date.now()
            : 30_000;
          if (remainingMs <= 0) {
            throw new Error("Refinement reached the route work deadline");
          }
          await page.setContent(html, {
            waitUntil: "networkidle",
            timeout: Math.max(1, Math.min(30_000, remainingMs)),
          });
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth > window.innerWidth + 2,
          );
          if (overflow) issues.push(`Horizontal overflow at ${viewport.label}.`);
          checkedViewports.push(viewport.label);
        } finally {
          await page.close().catch(() => undefined);
        }
      }
    } finally {
      await browser.close().catch(() => undefined);
    }
  } catch (err) {
    if (options?.signal?.aborted) throw err;
    console.warn("[refine] Playwright QA skipped", err);
  }

  return { pass: issues.length === 0, issues, checkedViewports };
}

export async function POST(req: Request) {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return badRequest("Request body must be JSON");
  }

  const html = typeof body.html === "string" ? body.html.trim() : "";
  const instruction =
    typeof body.instruction === "string" ? body.instruction.trim() : "";
  const clientName =
    typeof body.clientName === "string" && body.clientName.trim()
      ? body.clientName.trim()
      : "the client";
  const mockupName =
    typeof body.mockupName === "string" && body.mockupName.trim()
      ? body.mockupName.trim()
      : "Selected design";
  const provider: GenerationProvider =
    body.generationProvider === "anthropic" ? "anthropic" : "openai";

  if (!html.startsWith("<!DOCTYPE html")) {
    return badRequest("Mockup HTML is required");
  }
  if (instruction.length < 4) {
    return badRequest("Please enter a refinement instruction");
  }

  const apiKey =
    provider === "openai"
      ? process.env.OPENAI_API_KEY
      : process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          provider === "openai"
            ? "Server is missing OPENAI_API_KEY"
            : "Server is missing ANTHROPIC_API_KEY",
      },
      { status: 500 },
    );
  }

  const startedAt = Date.now();
  const routeWorkDeadlineAt = startedAt + ROUTE_WORK_DEADLINE_MS;
  const { protectedHtml, assets } = protectDataUrls(html);
  const prompt = buildPrompt({
    clientName,
    mockupName,
    instruction,
    html: protectedHtml,
    projectBrief: typeof body.projectBrief === "string" ? body.projectBrief : "",
    styleNotes: typeof body.styleNotes === "string" ? body.styleNotes : "",
  });

  try {
    console.log("[refine] request", {
      provider,
      clientName,
      mockupName,
      instructionChars: instruction.length,
      protectedHtmlChars: protectedHtml.length,
      embeddedAssets: assets.length,
    });
    const text =
      provider === "openai"
        ? await callOpenAI(
            apiKey,
            prompt,
            req.signal,
            routeWorkDeadlineAt,
          )
        : await callAnthropic(apiKey, prompt);
    const revisedProtectedHtml = parseHtml(text, protectedHtml);
    const revisedHtml = restoreDataUrls(revisedProtectedHtml, assets);
    const qaReport = await quickQa(revisedHtml, {
      deadlineAt: routeWorkDeadlineAt,
      signal: req.signal,
    });
    console.log("[refine] success", {
      provider,
      qaPass: qaReport.pass,
      issues: qaReport.issues.length,
      elapsedSec: ((Date.now() - startedAt) / 1000).toFixed(1),
    });

    return NextResponse.json({ mockup: { name: mockupName, html: revisedHtml }, qaReport });
  } catch (err) {
    console.error("[refine] failed", err);
    const message =
      err instanceof Anthropic.APIError
        ? `Anthropic API error: ${err.message}`
        : err instanceof Error
          ? err.message
          : "Refinement failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
