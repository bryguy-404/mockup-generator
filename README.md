# Mockup Generator

A single-page Next.js app that generates three distinct premium homepage mockups for a client. You provide inspiration URLs, current-site URL, logo, client business photos, screenshots, project direction, brand colors, and client name. The app uses a staged workflow: Firecrawl research, AI creative directions, mockup generation, Playwright visual QA, and one repair pass. Results are standalone HTML files (Tailwind via CDN) rendered in iframes with per-mockup refinement, download, share, and handoff buttons.

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
   - `OPENAI_REASONING_EFFORT` = `max` (optional override)
   - `OPENAI_REASONING_MODE` = `pro` (optional override)
   - `ANTHROPIC_MOCKUP_MODEL` = `claude-fable-5` (optional override)
   - `ANTHROPIC_EXPORT_MODEL` = `claude-fable-5` (optional override)
   - `ANTHROPIC_REASONING_EFFORT` = `max` (optional override)
5. Click **Deploy**. Railway runs `npm run build` then `npm run start`; `PORT` is injected automatically and Next.js binds to it.

## How it works

- `src/app/page.tsx` — client component with the form and results grid. Client photos and screenshots are compressed in-browser to about 1800px max dimension and a 1.5MB cap before being sent as data URLs. Each client image can be tagged as hero, services, team, gallery, or general. The direction step includes a form-needed selector so generated mockups can intentionally include or avoid contact, quote, booking, newsletter, or custom lead forms.
- `src/app/api/generate/route.ts` — premium server route that validates inputs, uses Firecrawl for shared research when configured, asks the selected provider for brand/inspiration analysis and creative directions, generates mockups, renders them with Playwright at mobile/tablet/desktop sizes, runs model QA, and repairs failing concepts once. Anthropic defaults to Claude Fable 5 at max effort. OpenAI defaults to GPT-5.6 Sol in Pro mode at max effort.
- `src/app/api/refine/route.ts` — targeted per-mockup refinement route. It protects embedded image data, asks the selected provider to revise one HTML mockup from the user's edit notes, restores the images, and runs a quick responsive overflow QA check.
- `src/app/api/export/route.ts` — server route behind **Use This Design**. It creates the AI handoff bundle: `CLAUDE_KICKOFF.md`, `BUILD_PROMPT.md`, `BLUEPRINT.md`, `theme.config.ts`, and `design/index.html`. The kickoff scaffold defaults to static Astro for Cloudflare Pages (`npm run build`, output `dist`) and avoids the Cloudflare adapter/Wrangler path unless server runtime features are explicitly needed. If a generated design includes a contact or lead form, the build prompt instructs the agent to use a Cloudflare Pages Function at `functions/api/contact.ts` with Resend secrets read from the function environment.

## Notes

- The generation, refinement, and export routes set `maxDuration = 900` to accommodate max-effort premium generations.
- Firecrawl uses `/v2/scrape` for markdown, screenshots, links/images, and branding. If Firecrawl is missing or fails for a URL, the selected model can still use provider web tools.
- Playwright is used server-side for QA screenshots. If browser rendering fails in an environment, generation continues with static QA checks instead of crashing.
- Mockups render in iframes with `sandbox="allow-scripts"` so the Tailwind CDN can apply styles, but the iframe origin stays null and can't reach the host page.
- Each generation has provider costs: Firecrawl credits, model input/output tokens, vision inputs for QA, and any hosted web tool usage.
