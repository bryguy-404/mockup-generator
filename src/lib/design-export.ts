import JSZip from "jszip";

const handoffFiles = {
  kickoff: "CLAUDE_KICKOFF.md",
  buildPrompt: "BUILD_PROMPT.md",
  blueprint: "BLUEPRINT.md",
  themeConfig: "theme.config.ts",
  runLoop: "RUN_LOOP.md",
  visualDiff: "visual-diff.mjs",
} as const;

const cmsPaths = [
  "PAGES_CMS.md",
  "cms-starter/.pages.yml",
  "cms-starter/AGENTS.md",
  "cms-starter/src/data/site.json",
  "cms-starter/src/data/pages/home.json",
  "cms-starter/public/uploads/.gitkeep",
] as const;

// Keep download assembly separate so the API → ZIP boundary can be verified.
export function buildDesignZip(
  data: Record<string, unknown>,
  html: string,
): JSZip {
  const zip = new JSZip();
  for (const [key, path] of Object.entries(handoffFiles)) {
    const value = data[key];
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`The export is missing ${path}. Please try again.`);
    }
    zip.file(path, value);
  }

  if (!data.cmsFiles || typeof data.cmsFiles !== "object") {
    throw new Error("The export is missing the Pages CMS starter. Please try again.");
  }
  const cmsFiles = data.cmsFiles as Record<string, unknown>;
  for (const path of cmsPaths) {
    const value = cmsFiles[path];
    if (
      typeof value !== "string" ||
      (!path.endsWith("/.gitkeep") && !value.trim())
    ) {
      throw new Error(`The export is missing ${path}. Please try again.`);
    }
    zip.file(path, value);
  }

  zip.file("design/index.html", html);
  return zip;
}
