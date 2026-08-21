import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchRemoteImage, remoteImageInternals } from "@/lib/remote-image";

describe("remote image hardening", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("rejects private and reserved addresses", async () => {
    await expect(fetchRemoteImage("http://127.0.0.1/logo.png")).rejects.toThrow(
      "Private or reserved",
    );
    expect(remoteImageInternals.isPrivateAddress("10.0.0.1")).toBe(true);
    expect(remoteImageInternals.isPrivateAddress("192.168.1.2")).toBe(true);
    expect(remoteImageInternals.isPrivateAddress("93.184.216.34")).toBe(false);
  });

  it("rejects invalid MIME types and oversized declared responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("not an image", {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      ),
    );
    await expect(
      fetchRemoteImage("https://93.184.216.34/file.txt"),
    ).rejects.toThrow("supported image type");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("small", {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": String(6 * 1024 * 1024),
          },
        }),
      ),
    );
    await expect(
      fetchRemoteImage("https://93.184.216.34/large.png"),
    ).rejects.toThrow("larger than 5MB");
  });

  it("removes executable and external SVG content before rasterization", () => {
    const sanitized = remoteImageInternals.sanitizeSvg(
      '<svg onload="alert(1)"><script>alert(1)</script><image href="https://evil.example/x" /></svg>',
    );
    expect(sanitized).not.toMatch(/script|onload|https:\/\/evil/i);
    expect(sanitized).toContain("<svg");
  });
});
