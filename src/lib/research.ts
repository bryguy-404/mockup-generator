import type {
  RemoteAssetCandidate,
  ResearchContext,
  ResearchContextPage,
} from "@/lib/intake";

const MAX_RESEARCH_CHARS_PER_PAGE = 12_000;
const CACHE_TTL_MS = 30 * 60 * 1_000;
const CACHE_MAX_ENTRIES = 100;

export type ResearchPage = {
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

export type ResearchPacket = {
  currentSite?: ResearchPage;
  inspirations: ResearchPage[];
  source: "firecrawl" | "provider-tools" | "mixed";
};

type CacheEntry = { expiresAt: number; value: ResearchPage };
const researchCache = new Map<string, CacheEntry>();

function truncate(value: string, max = MAX_RESEARCH_CHARS_PER_PAGE) {
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n\n[truncated ${value.length - max} chars]`;
}

function normalizeUrl(raw: string) {
  const parsed = new URL(raw);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only HTTP(S) website URLs are supported");
  }
  parsed.hash = "";
  parsed.hostname = parsed.hostname.toLowerCase();
  if (parsed.pathname === "/") parsed.pathname = "";
  return parsed.toString();
}

function cacheKey(url: string, kind: ResearchPage["kind"]) {
  return `${kind}:${normalizeUrl(url)}`;
}

function pruneCache() {
  const now = Date.now();
  for (const [key, entry] of Array.from(researchCache.entries())) {
    if (entry.expiresAt <= now) researchCache.delete(key);
  }
  while (researchCache.size > CACHE_MAX_ENTRIES) {
    const firstKey = researchCache.keys().next().value as string | undefined;
    if (!firstKey) break;
    researchCache.delete(firstKey);
  }
}

export function clearResearchCacheForTests() {
  researchCache.clear();
}

export async function scrapeFirecrawl(
  rawUrl: string,
  kind: ResearchPage["kind"],
  options?: { deadlineAt?: number; signal?: AbortSignal; bypassCache?: boolean },
): Promise<ResearchPage> {
  const url = normalizeUrl(rawUrl);
  const key = cacheKey(url, kind);
  pruneCache();
  const cached = researchCache.get(key);
  if (!options?.bypassCache && cached && cached.expiresAt > Date.now()) {
    researchCache.delete(key);
    researchCache.set(key, cached);
    return cached.value;
  }

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
    throw new Error("Website research reached its deadline");
  }
  const timeout = setTimeout(
    () => controller.abort(),
    Math.max(1, Math.min(65_000, remainingMs)),
  );

  try {
    const response = await fetch("https://api.firecrawl.dev/v2/scrape", {
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
        timeout: 60_000,
      }),
      signal: controller.signal,
    });
    const json = (await response.json().catch(() => null)) as {
      success?: boolean;
      data?: Record<string, unknown>;
      error?: string;
    } | null;
    if (!response.ok || !json?.success || !json.data) {
      throw new Error(json?.error || `Firecrawl error (${response.status})`);
    }
    const data = json.data;
    const value: ResearchPage = {
      url,
      kind,
      source: "firecrawl",
      markdown: truncate(typeof data.markdown === "string" ? data.markdown : ""),
      screenshotDataUrl:
        typeof data.screenshot === "string" && data.screenshot.startsWith("data:image/")
          ? data.screenshot
          : undefined,
      links: Array.isArray(data.links)
        ? data.links.filter((item): item is string => typeof item === "string").slice(0, 30)
        : [],
      images: Array.isArray(data.images)
        ? data.images.filter((item): item is string => typeof item === "string").slice(0, 30)
        : [],
      branding: data.branding ?? null,
    };
    researchCache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
    pruneCache();
    return value;
  } catch (error) {
    if (options?.signal?.aborted) throw error;
    if (options?.deadlineAt && Date.now() >= options.deadlineAt) {
      throw new Error("Website research reached its deadline", { cause: error });
    }
    return {
      url,
      kind,
      source: "provider-tools",
      markdown: "",
      links: [],
      images: [],
      branding: null,
      error: error instanceof Error ? error.message : "Firecrawl scrape failed",
    };
  } finally {
    clearTimeout(timeout);
    options?.signal?.removeEventListener("abort", forwardAbort);
  }
}

export async function buildResearchPacket(
  currentSite: string,
  inspirationUrls: string[],
  options?: { deadlineAt?: number; signal?: AbortSignal },
): Promise<ResearchPacket> {
  const pages = await Promise.all([
    currentSite
      ? scrapeFirecrawl(currentSite, "current", options)
      : Promise.resolve(undefined),
    ...inspirationUrls.slice(0, 3).map((url) =>
      scrapeFirecrawl(url, "inspiration", options),
    ),
  ]);
  const current = pages[0] as ResearchPage | undefined;
  const inspirations = pages
    .slice(1)
    .filter((page): page is ResearchPage => Boolean(page));
  const all = [current, ...inspirations].filter(Boolean) as ResearchPage[];
  const firecrawlCount = all.filter((page) => page.source === "firecrawl").length;
  const source =
    firecrawlCount === all.length && all.length > 0
      ? "firecrawl"
      : firecrawlCount > 0
        ? "mixed"
        : "provider-tools";
  return { currentSite: current, inspirations, source };
}

export function buildResearchSummary(packet: ResearchPacket) {
  const pages = [packet.currentSite, ...packet.inspirations].filter(Boolean) as ResearchPage[];
  return pages
    .map((page) => {
      const status = page.error ? `FAILED: ${page.error}` : `${page.markdown.length} chars`;
      return `${page.kind.toUpperCase()} ${page.url} (${page.source}) ${status}`;
    })
    .join("\n");
}

function titleFromMarkdown(markdown: string) {
  return markdown.match(/^#\s+(.+)$/m)?.[1]?.trim().slice(0, 160) ?? "";
}

function collectStrings(value: unknown, depth = 0): string[] {
  if (depth > 5) return [];
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap((item) => collectStrings(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.values(value).flatMap((item) => collectStrings(item, depth + 1));
  }
  return [];
}

function validRemoteUrl(value: string) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function collectColors(branding: unknown) {
  const joined = collectStrings(branding).join(" ");
  return Array.from(
    new Set((joined.match(/#[0-9a-f]{6}\b/gi) ?? []).map((color) => color.toUpperCase())),
  )
    .slice(0, 8);
}

function buildAssetCandidates(page: ResearchPage): RemoteAssetCandidate[] {
  if (page.kind !== "current") return [];
  const brandingStrings = collectStrings(page.branding);
  const brandingUrls = brandingStrings.filter(validRemoteUrl);
  const logoUrls = brandingUrls.filter((url) => /logo|brand|icon/i.test(url));
  const images = Array.from(
    new Set([...logoUrls, ...page.images.filter(validRemoteUrl)]),
  ).slice(0, 12);
  return images.map((url, index) => {
    const isLogo = logoUrls.includes(url) || /logo|brandmark/i.test(url);
    return {
      id: `remote_${index + 1}`,
      kind: isLogo ? "logo" : "image",
      url,
      sourceUrl: page.url,
      label: isLogo ? "Possible website logo" : "Current-site image",
      confidence: isLogo ? "medium" : "low",
    };
  });
}

function contextPage(page: ResearchPage): ResearchContextPage {
  const branding = JSON.stringify(page.branding ?? null).slice(0, 2_000);
  const cleanMarkdown = page.markdown.replace(/\s+/g, " ").trim();
  return {
    url: page.url,
    kind: page.kind,
    source: page.source,
    title: titleFromMarkdown(page.markdown),
    summary: cleanMarkdown.slice(0, 4_000),
    branding,
    colors: collectColors(page.branding),
  };
}

export function toResearchContext(packet: ResearchPacket): ResearchContext {
  const pages = [packet.currentSite, ...packet.inspirations].filter(Boolean) as ResearchPage[];
  const assetCandidates = pages.flatMap(buildAssetCandidates).slice(0, 12);
  return {
    currentSite: packet.currentSite ? contextPage(packet.currentSite) : undefined,
    inspirations: packet.inspirations.map(contextPage),
    source: packet.source,
    assetCandidates,
    colorCandidates: Array.from(
      new Set(pages.flatMap((page) => collectColors(page.branding))),
    ).slice(0, 8),
    fetchedAt: Date.now(),
  };
}
