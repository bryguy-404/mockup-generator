import { NextResponse } from "next/server";
import Anthropic from "@anthropic-ai/sdk";
import {
  MODEL_OUTPUT_TOKENS,
  assertAnthropicResponseComplete,
  getAnthropicExportConfig,
} from "@/lib/ai-models";
import { buildRunLoopMd, getVisualDiffMjs } from "./handoff-assets";
import { buildCmsFiles } from "./cms-assets";

export const runtime = "nodejs";
export const maxDuration = 900;

type RequestBody = {
  html?: unknown;
  clientName?: unknown;
};

type ExportPayload = {
  blueprint: string;
  themeConfig: string;
};

function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

function sanitizeHtmlForExport(html: string): string {
  // Embedded base64 image data URLs (typically the client's uploaded logo)
  // can be hundreds of KB. They blow up the input token count and add no
  // signal — Claude doesn't need pixels to write a blueprint, just structure.
  // Replace any base64 image data URL longer than 200 chars with a short marker.
  return html.replace(
    /data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]{200,}/g,
    "[CLIENT_LOGO_DATA_URL]",
  );
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "client"
  );
}

function buildPrompt(args: { clientName: string; html: string }) {
  const { clientName, html } = args;

  return `You are a senior web designer preparing a hand-off package for an AI coding agent that will rebuild the design as a real Astro project for ${clientName}.

You are given the final HTML mockup below. Read it carefully and produce two files derived from it.

Return ONLY a JSON object (no prose, no markdown fences) with this exact shape:
{ "blueprint": "...", "themeConfig": "..." }

Each value is the raw file content as a single string. No backticks. No extra commentary.

================
FILE 1 — blueprint
================
A markdown document (will be saved as BLUEPRINT.md). Required sections, in order, each as a level-2 heading except the title:

# ${clientName} — Design Blueprint

## Overall direction & vibe
2–3 sentences capturing the design's mood, audience, and personality.

## Section-by-section breakdown
For each section in the mockup (header, hero, services/features, testimonials/social proof, CTA, footer, plus anything else present), describe layout, content intent, and key visual moves.

## Typography
Font families used (heading and body), sizing approach, weight choices, any notable letter-spacing or line-height treatments.

## Color palette
List every meaningful color with its hex code and role (primary, accent, surface, foreground, muted, etc.).

## Spacing & layout
Container widths, vertical rhythm, grid choices, breakpoints inferred from the markup.

## Unique visual treatments
Anything worth preserving: gradients, glassmorphism, custom shapes, illustration style, motion cues, etc.

## Editable content plan
For each section, identify the existing text, button labels/destinations, and photos/alt text that should be editable in Pages CMS. Separate shared business details from page-specific content. Use descriptive section/field names. Layout, styles, routes, and code remain fixed. Do not invent additional pages or content. The build agent will implement this plan using the bundled PAGES_CMS.md and cms-starter/ files.

Write it so an AI coding agent can recreate the design in Astro + Tailwind without seeing the original HTML.

================
FILE 2 — themeConfig
================
A TypeScript module (will be saved as theme.config.ts). Use this exact shape and fill values extracted from the HTML:

export const theme = {
  colors: {
    primary: "#...",
    secondary: "#...",
    accent: "#...",
    background: "#...",
    foreground: "#...",
    muted: "#...",
  },
  fonts: {
    heading: "...",
    body: "...",
  },
  radius: {
    sm: "...",
    md: "...",
    lg: "...",
  },
} as const;

export type Theme = typeof theme;

Use real hex values you can read from the HTML (or sensibly infer from Tailwind classes used). Use real CSS font-family stacks. Use rem or px values for radius (e.g., "0.5rem"). Do NOT add comments. Do NOT add fields beyond the shape above.

================
HTML MOCKUP
================
${html}
`;
}

function buildKickoffMd(clientName: string, clientSlug: string): string {
  return `# Build the ${clientName} Astro site — Phase 1 (Scaffold)

You are a coding agent (Codex or Claude Code) working in the project folder. **This prompt only handles the project scaffold.** The homepage and Pages CMS integration are built later using \`BUILD_PROMPT.md\` once the handoff files are in the workspace.

This is a static Astro marketing site intended for Cloudflare Pages. Do not install \`@astrojs/cloudflare\`, \`wrangler\`, or any Cloudflare adapter unless the project explicitly needs SSR, API routes, Cloudflare bindings, KV, D1, or Workers runtime features.

## What to do

Scaffold a fresh Astro project in a new subfolder named \`${clientSlug}\` (relative to the current working directory). Use the Astro CLI **non-interactively** so the install does not stall on prompts:

\`\`\`bash
npm create astro@latest ${clientSlug} -- --template minimal --typescript strict --install --no-git --skip-houston --yes
\`\`\`

Then initialize git (Astro skipped this because of \`--no-git\` above) and add the required integrations, also non-interactively:

\`\`\`bash
cd ${clientSlug}
git init -b main
npx astro add tailwind --yes
npx astro add mdx --yes
\`\`\`

Before committing, make sure \`.gitignore\` contains these generated/local-only paths:

\`\`\`gitignore
.wrangler/
dist/
.astro/
node_modules/
\`\`\`

Stage everything and create a baseline commit so the user has a clean rollback point:

\`\`\`bash
git add .
git commit -m "Initial Astro scaffold: TypeScript + Tailwind + MDX"
\`\`\`

Verify the dev server boots cleanly:

\`\`\`bash
npm run dev
\`\`\`

Stop the server after ~5 seconds. If anything errored, fix it and try again. Then report done.

## What NOT to do

- Do **NOT** build the homepage yet.
- Do **NOT** modify \`tailwind.config.ts\` beyond what \`astro add tailwind\` produces.
- Do **NOT** add additional dependencies.
- Do **NOT** install \`@astrojs/cloudflare\`, \`wrangler\`, or add \`wrangler.jsonc\` for this static Cloudflare Pages scaffold.

## Cloudflare Pages deploy settings

When this site is pushed to GitHub and connected to Cloudflare Pages, use:

- Build command: \`npm run build\`
- Build output directory: \`dist\`

## Hand-off back to the user

When the scaffold is verified, tell the user to:

1. Move \`BLUEPRINT.md\`, \`theme.config.ts\`, \`design/\`, \`BUILD_PROMPT.md\`, \`PAGES_CMS.md\`, the entire \`cms-starter/\` folder (including its hidden \`.pages.yml\`), \`RUN_LOOP.md\`, and \`visual-diff.mjs\` into the new \`${clientSlug}/\` folder (alongside \`src/\`, \`public/\`, etc.). Preserve existing files if already moved.
2. Open \`${clientSlug}/\` as the project in Codex or your coding editor.
3. Use \`BUILD_PROMPT.md\` to continue with Phase 2. It requires the agent to finish the CMS fields and connect them while building; downloading the starter alone does not connect the website to Pages CMS.
`;
}

function buildBuildPromptMd(clientName: string, clientSlug: string): string {
  return `# Build the ${clientName} homepage — Phase 2 (Design + content editing)

You are a coding agent (Codex or Claude Code). The scaffolded Astro project for **${clientName}** is open as the workspace, and the design hand-off files are already in this workspace.

## Source of truth (already in this workspace)

- \`design/index.html\` — the rendered homepage mockup (frozen reference)
- \`BLUEPRINT.md\` — design intent: vibe, sections, typography, palette, spacing, unique treatments
- \`theme.config.ts\` — extracted theme tokens (colors, fonts, radius). You will move this to \`src/lib/theme.config.ts\` in step 1; from then on, treat \`src/lib/theme.config.ts\` as the canonical theme source.
- \`PAGES_CMS.md\` — required content architecture, image handling, verification, and account setup guide
- \`cms-starter/\` — starter \`.pages.yml\`, JSON content, uploads folder, and project instructions to copy/merge into the Astro project

Read the references and starter files before writing any code. Pages CMS integration is part of this build, not an optional follow-up.

## What to do

1. **Move \`theme.config.ts\` into \`src/lib/\`.** Before anything else, move \`theme.config.ts\` from this folder into \`src/lib/theme.config.ts\` so all live code lives under \`src/\`. The \`design/\` folder remains a frozen reference (only \`index.html\` and any other reference assets stay there). Update any imports to point at the new path.

2. **Wire the theme tokens into Tailwind.** First, detect which Tailwind version was installed by \`astro add tailwind\`:
   - Check \`package.json\` for \`tailwindcss\` (or \`@tailwindcss/vite\`) — if the major version is **4 or higher**, use the v4 CSS-first config: define an \`@theme\` block in your global stylesheet (typically \`src/styles/global.css\`) and mirror the values from \`theme.config.ts\` into it (CSS custom properties like \`--color-primary\`, \`--font-heading\`, \`--radius-md\`). Keep \`theme.config.ts\` as-is so non-CSS code can still import it.
   - If the major version is **3**, use the v3 JS config: create/update \`tailwind.config.ts\` to import \`theme.config.ts\` and drive \`theme.extend.colors\`, \`theme.extend.fontFamily\`, and \`theme.extend.borderRadius\` from it.

   Either way, the goal is: tokens live in \`theme.config.ts\` (or its CSS mirror), and components reference them by semantic name. **No hard-coded hex values in components.**

3. **Color naming — handle the mockup's class style, do NOT ask the user.** Inspect the color classes used in \`design/index.html\` and decide which case applies:

   - **Case A — stock Tailwind palette classes** (e.g. \`bg-stone-50\`, \`text-slate-900\`, \`border-zinc-200\`): these are placeholders, not design tokens. **Translate them to the semantic tokens** in \`src/lib/theme.config.ts\` — e.g. \`bg-stone-50\` → \`bg-background\`, \`text-slate-900\` → \`text-foreground\`. Components reference the semantic names; the raw palette names disappear.

   - **Case B — brand-evocative custom names** (e.g. \`bg-sage\`, \`bg-lavender\`, \`text-cream\`, \`bg-warmGray\`): these are meaningful brand tokens. **Keep them as-is in components** AND **add them as aliases in \`src/lib/theme.config.ts\`** so the TS file still drives the values. Then expose the same names in Tailwind (v4 \`@theme\` block, or v3 \`theme.extend.colors\`). Both the mockup HTML and your components reference the same brand names — no rename pass needed.

   - **Case C — mixed**: prefer the brand names (more design-meaningful). For any stock palette class describing the same color as a brand name, replace with the brand name.

   In all cases, components must never reference hex values directly — every color goes through \`src/lib/theme.config.ts\` (or its CSS-mirror in v4). Pick the case that matches the mockup and proceed; do not stop to ask the user which naming style to use.

4. **Prepare Pages CMS content before rendering components.** Follow \`PAGES_CMS.md\`: install the starter files, merge the provided \`AGENTS.md\` instructions, and populate/expand the JSON and \`.pages.yml\` to match the approved design. Use \`src/data/site.json\` for shared details and \`src/data/pages/home.json\` for homepage content. Give every additional page actually built its own JSON file and matching editor entry. Use fixed fields grouped by page/section and disable content creation, renaming, and deletion. Keep layout and routes in code. Do not introduce a CMS runtime dependency, database, custom auth, or SSR for this integration.

5. **Recreate the homepage** as accessible Astro components, section by section, faithful to \`design/index.html\` and \`BLUEPRINT.md\`. Break the page into reusable \`.astro\` components under \`src/components/\`. Import the prepared JSON at build time and bind every editable field to the rendered copy, links, metadata, or images. The editor must change the actual site, not unused duplicate content.

6. **Use the mockup's copy literally.** Populate the content files with the exact text in \`design/index.html\` — headings, body copy, button labels, testimonials, navigation links. The mockup was generated with the client's real voice and services in mind (often pulled from their existing site). Only invent new copy if a section is genuinely incomplete in the mockup; never lorem ipsum, never paraphrase the mockup's wording. Replace starter values rather than showing them as finished copy.

7. **Fully responsive** (mobile, tablet, desktop). Mobile-first. The viewport meta tag is already in Astro's default layout — confirm it. **If the mockup includes a mobile hamburger menu button, implement it as a functional toggle** (a small inline \`<script>\` controlling a hidden drawer, or an Astro client directive). Do NOT ship a button that does nothing just because the mockup omitted the drawer behavior — that's a mockup limitation, not a design choice. Editable images use \`public/uploads\` and \`/uploads/...\` URLs; bind their selected paths and alt text and preserve the intended crop when clients replace them.

8. **Accessibility** — semantic HTML, descriptive alt text, keyboard navigation, sufficient color contrast. Note any contrast issues that fall below WCAG AA in the hand-off summary; do not silently downgrade them.

9. **SEO-ready** — \`<title>\`, meta description, Open Graph tags, canonical URL. Bind editable metadata to the content files while keeping route/canonical configuration consistent with the actual site.

10. **Contact/lead forms — conditional Resend + Cloudflare Pages Functions.** If \`design/index.html\` includes a contact form, lead form, booking request form, quote request form, newsletter signup, or any other form that should send an email, implement it with Cloudflare Pages Functions and Resend:
   - Keep the Astro site static. Do **NOT** add \`@astrojs/cloudflare\`, \`wrangler.jsonc\`, SSR mode, or Astro API routes under \`src/pages/api\`.
   - Create the server endpoint at \`functions/api/contact.ts\` so it deploys as \`/api/contact\` on Cloudflare Pages.
   - Wire the browser form to submit to \`/api/contact\` using \`fetch\` or a normal form post. Never expose secrets in client-side code.
   - Read these values from the Pages Function \`env\` object: \`RESEND_API_KEY\`, \`RESEND_FROM_EMAIL\`, and \`CONTACT_TO_EMAIL\`.
   - Use direct \`fetch("https://api.resend.com/emails")\` inside the Pages Function rather than a separate backend. Include \`Authorization\` with the Resend API key, \`Content-Type: application/json\`, and a \`User-Agent\` header such as \`client-site-contact-form/1.0\`.
   - Send both \`text\` and \`html\` email bodies, set \`reply_to\` to the submitter's email, and include a clear subject with the site/client name.
   - Validate required fields server-side, trim submitted strings, cap message lengths, and return JSON responses like \`{ "ok": true }\` or \`{ "ok": false, "message": "..." }\`.
   - Add a hidden honeypot input named \`website\`; if it is filled, return \`{ "ok": true }\` without sending email.
   - Create \`.dev.vars.example\` with placeholders only:

     \`\`\`dotenv
     RESEND_API_KEY="re_xxxxxxxxxxxxxxxxxxxxxxxxx"
     RESEND_FROM_EMAIL="Business Name <leads@example.com>"
     CONTACT_TO_EMAIL="owner@example.com"
     \`\`\`

   - Ensure \`.gitignore\` ignores real local secrets while allowing examples:

     \`\`\`gitignore
     .dev.vars*
     .env*
     !.dev.vars.example
     !.env.example
     \`\`\`

   - Do not commit real API keys. In Cloudflare Pages, add \`RESEND_API_KEY\` as an encrypted secret and add \`RESEND_FROM_EMAIL\` / \`CONTACT_TO_EMAIL\` as project variables or secrets.
   - If there is no form that needs to send email, do not create \`functions/\`, \`.dev.vars.example\`, or any Resend-related files.

11. **Verify** — run \`npx astro check\` and \`npx astro build\`. Fix any errors before reporting done. Complete the content-file and replacement checks in \`PAGES_CMS.md\`: change text on each built page, a shared value, a button URL, and an image path/alt; rebuild and confirm the rendered output changes. Restore the approved content and rebuild before visual comparison or handoff. If a Pages Function was added, also verify the form handler locally after building with \`npx wrangler pages dev dist\` when Wrangler is available; Wrangler is only for local Pages Function testing and should not be committed as project config.

## Hand-off back to the user

When done, summarize what was built section by section, and note any decisions you made (e.g. invented copy, breakpoints not present in the mockup, components extracted).

Update \`PAGES_CMS.md\` with the actual editable field/page inventory, intentional exclusions, verification results, and the remaining GitHub, Cloudflare, and Pages CMS account steps. Do not claim the hosted editor is connected until verified. Leave repository connection, deployment, production merges, and client invitations to the owner's explicit instruction.

The slugified project name is \`${clientSlug}\`.
`;
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

function validatePayload(value: unknown): ExportPayload {
  if (typeof value !== "object" || value === null) {
    throw new Error("Model response was not an object");
  }
  const v = value as Record<string, unknown>;
  const blueprint = v.blueprint;
  const themeConfig = v.themeConfig;

  if (typeof blueprint !== "string" || blueprint.length < 200) {
    throw new Error("blueprint missing or too short");
  }
  if (!/^#\s|\n#\s/.test(blueprint)) {
    throw new Error("blueprint missing markdown heading");
  }

  if (typeof themeConfig !== "string") {
    throw new Error("themeConfig missing");
  }
  if (
    !themeConfig.includes("export const theme") ||
    !themeConfig.includes("colors") ||
    !themeConfig.includes("fonts") ||
    !themeConfig.includes("radius")
  ) {
    throw new Error("themeConfig missing required shape");
  }

  return { blueprint, themeConfig };
}

export async function POST(req: Request) {
  let body: RequestBody;
  try {
    body = (await req.json()) as RequestBody;
  } catch {
    return badRequest("Request body must be JSON");
  }

  const { html, clientName } = body;

  if (typeof html !== "string" || html.trim().length === 0) {
    return badRequest("Mockup HTML is required");
  }
  if (typeof clientName !== "string" || clientName.trim().length === 0) {
    return badRequest("Client name is required");
  }

  const trimmedClient = clientName.trim();
  const clientSlug = slugify(trimmedClient);

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Server is missing ANTHROPIC_API_KEY" },
      { status: 500 },
    );
  }

  const sanitizedHtml = sanitizeHtmlForExport(html);

  const prompt = buildPrompt({
    clientName: trimmedClient,
    html: sanitizedHtml,
  });

  const client = new Anthropic({ apiKey });

  const startedAt = Date.now();
  console.log("[export] request received", {
    clientName: trimmedClient,
    clientSlug,
    htmlChars: html.length,
    sanitizedHtmlChars: sanitizedHtml.length,
    strippedChars: html.length - sanitizedHtml.length,
    promptChars: prompt.length,
  });

  try {
    const { model, reasoningEffort } = getAnthropicExportConfig();
    console.log(
      `[export] streaming Claude (model=${model}, effort=${reasoningEffort}, max_tokens=${MODEL_OUTPUT_TOKENS.export})…`,
    );
    const stream = client.messages.stream({
      model,
      max_tokens: MODEL_OUTPUT_TOKENS.export,
      output_config: { effort: reasoningEffort },
      messages: [{ role: "user", content: prompt }],
    });

    stream.on("connect", () => {
      console.log(
        `[export] connected (+${((Date.now() - startedAt) / 1000).toFixed(1)}s)`,
      );
    });

    let textChars = 0;
    stream.on("text", (delta) => {
      const before = textChars;
      textChars += delta.length;
      if (Math.floor(before / 5000) !== Math.floor(textChars / 5000)) {
        const t = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.log(`[export] +${t}s writing… ${textChars} chars so far`);
      }
    });

    const response = await stream.finalMessage();
    assertAnthropicResponseComplete(response);

    const elapsedMs = Date.now() - startedAt;
    console.log("[export] Claude responded", {
      elapsedSec: (elapsedMs / 1000).toFixed(1),
      stop_reason: response.stop_reason,
      usage: response.usage,
    });

    const text = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trim();

    if (!text) {
      throw new Error("Model returned no text content");
    }

    const parsed = extractJson(text);
    const payload = validatePayload(parsed);

    const kickoff = buildKickoffMd(trimmedClient, clientSlug);
    const buildPromptMd = buildBuildPromptMd(trimmedClient, clientSlug);
    const runLoop = buildRunLoopMd(clientSlug);
    const visualDiff = getVisualDiffMjs();
    const cmsFiles = buildCmsFiles(trimmedClient);

    console.log("[export] success", {
      slug: clientSlug,
      blueprintChars: payload.blueprint.length,
      themeConfigChars: payload.themeConfig.length,
      kickoffChars: kickoff.length,
      buildPromptChars: buildPromptMd.length,
      runLoopChars: runLoop.length,
      visualDiffChars: visualDiff.length,
      elapsedSec: ((Date.now() - startedAt) / 1000).toFixed(1),
    });

    return NextResponse.json({
      slug: clientSlug,
      blueprint: payload.blueprint,
      themeConfig: payload.themeConfig,
      kickoff,
      buildPrompt: buildPromptMd,
      runLoop,
      visualDiff,
      cmsFiles,
    });
  } catch (err) {
    console.error(
      "[export] failed after",
      ((Date.now() - startedAt) / 1000).toFixed(1),
      "s:",
      err,
    );
    const message =
      err instanceof Anthropic.APIError
        ? `Anthropic API error: ${err.message}`
        : err instanceof Error
          ? err.message
          : "Export failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
