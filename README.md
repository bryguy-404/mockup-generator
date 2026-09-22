# Mockup Generator

A single-page Next.js app that generates three distinct premium homepage mockups for a client. Start with the optional AI Brief to describe the project conversationally, paste website links, and attach images; GPT-5.6 Terra researches the sites and prepares an evidence-backed form draft for review. You can also use the manual intake directly. The app then runs Firecrawl research, AI creative directions, mockup generation, Playwright visual QA, and one repair pass. Results are standalone HTML files (Tailwind via CDN) rendered in iframes with per-mockup refinement, download, share, and handoff buttons.

## Local setup

```bash
npm install
cp .env.example .env.local
# edit .env.local and set ANTHROPIC_API_KEY=sk-ant-...
# set OPENAI_API_KEY=sk-... to enable the OpenAI engine
# optional but recommended: set FIRECRAWL_API_KEY=fc-... for better website research
npm run dev
# open http://localhost:3000
```

Fill in the form, choose a generation engine, and click **Generate Mockups**. Premium generation can take several minutes because the app researches sites, creates design directions, generates three mockups, renders responsive screenshots, asks the model to critique them, and repairs weak concepts once.

## Deploy to Railway

1. Push this repo to GitHub.
2. Go to [railway.app](https://railway.app), **New Project → Deploy from GitHub**, and pick the repo.
3. Railway auto-detects Next.js — no custom build/start commands needed.
4. In the project's **Variables** tab, add:
   - `ANTHROPIC_API_KEY` = your Anthropic API key
   - `OPENAI_API_KEY` = your OpenAI API key (needed for the OpenAI engine)
   - `FIRECRAWL_API_KEY` = your Firecrawl API key (recommended; falls back to provider web tools if omitted)
   - `OPENAI_MOCKUP_MODEL` = `gpt-5.6-sol` (optional override)
   - `OPENAI_INTAKE_MODEL` = `gpt-5.6-terra` (optional AI Brief override)
   - `OPENAI_INTAKE_REASONING_EFFORT` = `medium` (optional AI Brief override)
   - `OPENAI_REASONING_EFFORT` = `max` (optional override)
   - `OPENAI_REASONING_MODE` = `pro` (optional override)
   - `OPENAI_SERVICE_TIER` = `fast` (optional override; premium lower-latency processing)
   - `ANTHROPIC_MOCKUP_MODEL` = `claude-fable-5` (optional override)
   - `ANTHROPIC_EXPORT_MODEL` = `claude-fable-5` (optional override)
   - `ANTHROPIC_REASONING_EFFORT` = `max` (optional override)
5. Click **Deploy**. Railway runs `npm run build` then `npm run start`; `PORT` is injected automatically and Next.js binds to it.

## How it works

- `src/app/page.tsx` — client component with the manual form and results grid. The optional AI Brief step supports a one-shot brief plus conversational follow-ups, sourced/confidence-rated draft values, attachment role review, explicit apply, and session-only history. Client photos and screenshots are compressed in-browser to about 1800px max dimension and a 1.5MB cap before being sent as data URLs.
- `src/app/api/intake/route.ts` — validates the AI Brief conversation and images, reuses Firecrawl research, calls GPT-5.6 Terra with strict structured output, and returns a reviewable draft without mutating the manual form. If Firecrawl fails, Terra can use web search with a reduced-confidence warning.
- `src/app/api/generate/route.ts` — premium server route that validates inputs, uses Firecrawl for shared research when configured, asks the selected provider for brand/inspiration analysis and creative directions, generates mockups, renders them with Playwright at mobile/tablet/desktop sizes, runs model QA, and repairs failing concepts once. Anthropic defaults to Claude Fable 5 at max effort. OpenAI defaults to GPT-5.6 Sol in Pro mode at max effort.
- `src/app/api/refine/route.ts` — targeted per-mockup refinement route. It protects embedded image data, asks the selected provider to revise one HTML mockup from the user's edit notes, restores the images, and runs a quick responsive overflow QA check.
- `src/app/api/export/route.ts` — server route behind **Use This Design**. It creates the AI handoff bundle: `CLAUDE_KICKOFF.md` (usable with Codex or Claude Code), `BUILD_PROMPT.md`, `BLUEPRINT.md`, `theme.config.ts`, `design/index.html`, `RUN_LOOP.md`, `visual-diff.mjs`, and the Pages CMS starter described below. The kickoff scaffold defaults to static Astro for Cloudflare Pages (`npm run build`, output `dist`) and avoids the Cloudflare adapter/Wrangler path unless server runtime features are explicitly needed. If a generated design includes a contact or lead form, the build prompt instructs the agent to use a Cloudflare Pages Function at `functions/api/contact.ts` with Resend secrets read from the function environment.

## Pages CMS in new design downloads

Every **Use This Design** ZIP includes `PAGES_CMS.md` and `cms-starter/` with a `.pages.yml` configuration, `src/data/site.json`, `src/data/pages/home.json`, `public/uploads/.gitkeep`, and an `AGENTS.md` content-maintenance guide. Starter files are deterministic; the original mockup remains the source for approved content and design. `src/lib/design-export.ts` validates the required files before assembling the download, including the hidden configuration file.

Both the two-phase prompts and `RUN_LOOP.md` require the coding agent to install the starter during the build, adapt the fields to the design, populate the exact approved copy, and bind the Astro components to the JSON data. Shared business information is edited once; every additional page built gets its own file/editor entry. Fixed content fields keep layout and routes in code. Editable images use `public/uploads` with `/uploads/...` URLs. Build instructions require checking actual text/link/photo replacement and restoring approved content before handoff.

The download is a foundation for a CMS-ready **build**, not an already connected editor. After building, the owner must authorize the GitHub repo in Pages CMS and connect Git-based deployment in Cloudflare Pages. Verify on a preview branch before enabling production editing or inviting clients. No custom login service, CMS runtime dependency, or hosted CMS subscription is added by the starter. Existing downloads and websites are unchanged.

## Notes

- OpenAI calls use background Responses API jobs with status polling so long Pro/max runs do not hit Node's five-minute response-header timeout. Polling defaults to every 2 seconds with a 30-minute library ceiling, additionally capped by the route's remaining work budget; timing can be overridden with `OPENAI_BACKGROUND_POLL_INTERVAL_MS`, `OPENAI_BACKGROUND_MAX_WAIT_MS`, and `OPENAI_HTTP_REQUEST_TIMEOUT_MS`.
- The generation, refinement, and export routes set `maxDuration = 900` to accommodate max-effort premium generations. The OpenAI generation and refinement paths reserve the final two minutes of that window for cleanup and returning the result; optional visual QA or repair work is skipped when too little time remains.
- Firecrawl uses `/v2/scrape` for markdown, screenshots, links/images, and branding. If Firecrawl is missing or fails for a URL, the selected model can still use provider web tools.
- Firecrawl research is shared through a bounded 100-entry, 30-minute in-memory cache. The cache is best effort and safely refetches after process restarts.
- Website logos and images found during AI Brief research are suggestions only. Confirmed imports pass through server-side URL, DNS, redirect, size, MIME, and SVG sanitization checks before being added to the form.
- Playwright is used server-side for QA screenshots. If browser rendering fails in an environment, generation continues with static QA checks instead of crashing.
- Mockups render in iframes with `sandbox="allow-scripts"` so the Tailwind CDN can apply styles, but the iframe origin stays null and can't reach the host page.
- Each generation has provider costs: Firecrawl credits, model input/output tokens, vision inputs for QA, and any hosted web tool usage.
