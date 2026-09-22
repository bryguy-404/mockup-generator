// @vitest-environment node
import JSZip from "jszip";
import { parse } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildDesignZip } from "@/lib/design-export";
import { POST } from "./route";

const { stream, finalMessage } = vi.hoisted(() => ({
  stream: vi.fn(),
  finalMessage: vi.fn(),
}));

vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    static APIError = class extends Error {};
    messages = { stream };
  },
}));

const html = '<!doctype html><html><body><h1>Approved copy</h1><img src="data:image/png;base64,' + "A".repeat(220) + '"></body></html>';
const modelPayload = {
  blueprint: "# Approved design\n\n" + "Preserve the approved content and layout. ".repeat(8),
  themeConfig: "export const theme = { colors: {}, fonts: {}, radius: {} } as const;",
};

async function exportDesign(clientName = 'Bryan’s "Design" & Co.') {
  const response = await POST(
    new Request("http://localhost/api/export", {
      method: "POST",
      body: JSON.stringify({ html, clientName }),
    }),
  );
  expect(response.status).toBe(200);
  return response.json();
}

type Field = { name: string; type: string; fields?: Field[] };

function expectMatchingFields(fields: Field[], content: Record<string, unknown>) {
  expect(Object.keys(content).sort()).toEqual(fields.map((field) => field.name).sort());
  for (const field of fields) {
    const value = content[field.name];
    if (field.type === "object") {
      expectMatchingFields(field.fields!, value as Record<string, unknown>);
    } else {
      expect(typeof value).toBe("string");
    }
  }
}

describe("design download with Pages CMS", () => {
  beforeEach(() => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key-never-sent");
    vi.spyOn(console, "log").mockImplementation(() => {});
    stream.mockReturnValue({ on: vi.fn(), finalMessage });
    finalMessage.mockResolvedValue({
      stop_reason: "end_turn",
      usage: {},
      content: [{ type: "text", text: JSON.stringify(modelPayload) }],
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("ships a complete ZIP with parseable CMS configuration and matching content files", async () => {
    const data = await exportDesign();
    const bytes = await buildDesignZip(data, html).generateAsync({ type: "uint8array" });
    const zip = await JSZip.loadAsync(bytes);
    expect(Object.values(zip.files).filter((file) => !file.dir)).toHaveLength(13);
    expect(await zip.file("design/index.html")!.async("string")).toBe(html);
    expect(await zip.file("BLUEPRINT.md")!.async("string")).toBe(modelPayload.blueprint);
    expect(await zip.file("theme.config.ts")!.async("string")).toBe(modelPayload.themeConfig);

    const config = parse(await zip.file("cms-starter/.pages.yml")!.async("string"));
    expect(config.media.input).toBe("public/uploads");
    expect(config.media.output).toBe("/uploads");
    expect(config.media.extensions).toContain("png");
    expect(zip.file(`cms-starter/${config.media.input}/.gitkeep`)).not.toBeNull();
    expect(config.content.map((entry: { name: string }) => entry.name)).toEqual(["site", "home"]);

    for (const entry of config.content) {
      expect(entry.type).toBe("file");
      expect(entry.operations).toEqual({ create: false, rename: false, delete: false });
      const file = zip.file(`cms-starter/${entry.path}`);
      expect(file, `Missing configured content file: ${entry.path}`).not.toBeNull();
      expectMatchingFields(entry.fields, JSON.parse(await file!.async("string")));
    }
    const site = JSON.parse(await zip.file("cms-starter/src/data/site.json")!.async("string"));
    expect(site.businessName).toBe('Bryan’s "Design" & Co.');
    const home = JSON.parse(await zip.file("cms-starter/src/data/pages/home.json")!.async("string"));
    expect(home.hero.heading).toBe(site.businessName);
    expect(await zip.file("cms-starter/AGENTS.md")!.async("string")).toContain("When adding a page");

    // Sanitizing the model input must not strip the user's assets from the download.
    expect(stream.mock.calls[0][0].messages[0].content).toContain("[CLIENT_LOGO_DATA_URL]");
  });

  it("includes CMS installation and verification in both build entry points", async () => {
    const data = await exportDesign("Example Client");
    expect(data.kickoff).toContain("cms-starter/");
    expect(data.kickoff).toContain("PAGES_CMS.md");
    expect(data.buildPrompt).toContain("Prepare Pages CMS content before rendering components");
    expect(data.buildPrompt).toContain("Restore the approved content");
    expect(data.runLoop).toContain("PAGES_CMS.md");
    expect(data.runLoop).toContain("Perform the local content and image replacement checks");
    expect(data.runLoop).toContain("example-client/");
    expect(data.runLoop).not.toContain("${clientSlug}");
    expect(data.visualDiff).toContain("VIEWPORTS");
    expect(data.cmsFiles["PAGES_CMS.md"]).toContain("Account steps after the site is built");
  });

  it("refuses an incomplete CMS download instead of silently shipping missing files", async () => {
    const data = await exportDesign();
    delete data.cmsFiles["cms-starter/.pages.yml"];
    expect(() => buildDesignZip(data, html)).toThrow("missing cms-starter/.pages.yml");
    delete data.cmsFiles;
    expect(() => buildDesignZip(data, html)).toThrow("missing the Pages CMS starter");
  });
});
