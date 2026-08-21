import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildResearchPacket, clearResearchCacheForTests } from "@/lib/research";

describe("shared Firecrawl research", () => {
  beforeEach(() => {
    clearResearchCacheForTests();
    process.env.FIRECRAWL_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.FIRECRAWL_API_KEY;
  });

  it("caches normalized URLs for intake and generation reuse", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ success: true, data: { markdown: "# Acme", branding: { colors: ["#112233"] } } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);
    await buildResearchPacket("https://ACME.example/#top", []);
    await buildResearchPacket("https://acme.example", []);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns provider fallback metadata when Firecrawl fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ success: false, error: "blocked" }), {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const packet = await buildResearchPacket("https://acme.example", []);
    expect(packet.source).toBe("provider-tools");
    expect(packet.currentSite?.error).toContain("blocked");
  });
});
