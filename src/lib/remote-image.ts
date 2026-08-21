import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_REMOTE_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 4;
const ALLOWED_RASTER_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
]);

function isPrivateIpv4(address: string) {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127) ||
    a >= 224
  );
}

function isPrivateIpv6(address: string) {
  const normalized = address.toLowerCase();
  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.")
  );
}

function isPrivateAddress(address: string) {
  const version = isIP(address);
  return version === 4 ? isPrivateIpv4(address) : version === 6 ? isPrivateIpv6(address) : true;
}

async function validateRemoteUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Remote images must use HTTP or HTTPS");
  }
  if (url.username || url.password) throw new Error("Authenticated image URLs are not supported");
  if (url.hostname.toLowerCase() === "localhost") throw new Error("Local image URLs are not allowed");
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((item) => isPrivateAddress(item.address))) {
    throw new Error("Private or reserved network image URLs are not allowed");
  }
  return url;
}

async function readBoundedBody(response: Response) {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > MAX_REMOTE_IMAGE_BYTES) throw new Error("Remote image is larger than 5MB");
  if (!response.body) throw new Error("Remote image response had no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_REMOTE_IMAGE_BYTES) {
      await reader.cancel();
      throw new Error("Remote image is larger than 5MB");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

function sanitizeSvg(svg: string) {
  if (!/<svg[\s>]/i.test(svg)) throw new Error("Remote SVG is invalid");
  return svg
    .replace(/<script\b[\s\S]*?<\/script\s*>/gi, "")
    .replace(/<foreignObject\b[\s\S]*?<\/foreignObject\s*>/gi, "")
    .replace(/\son[a-z]+\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/\s(?:href|xlink:href)\s*=\s*(["'])\s*(?:https?:|\/\/|data:)[\s\S]*?\1/gi, "");
}

export const remoteImageInternals = {
  isPrivateAddress,
  sanitizeSvg,
};

async function rasterizeSvg(buffer: Buffer) {
  const sanitized = sanitizeSvg(buffer.toString("utf8"));
  const sharp = (await import("sharp")).default;
  return sharp(Buffer.from(sanitized))
    .resize({ width: 1_800, height: 1_800, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
}

async function validateRasterDimensions(buffer: Buffer) {
  const sharp = (await import("sharp")).default;
  let metadata;
  try {
    metadata = await sharp(buffer, { animated: false }).metadata();
  } catch (error) {
    throw new Error("Remote image bytes could not be decoded", { cause: error });
  }
  const width = metadata.width ?? 0;
  const height = metadata.height ?? 0;
  if (!width || !height) throw new Error("Remote image dimensions could not be verified");
  if (width > 12_000 || height > 12_000 || width * height > 50_000_000) {
    throw new Error("Remote image dimensions are too large");
  }
  return { width, height };
}

export async function fetchRemoteImage(
  rawUrl: string,
  options?: { signal?: AbortSignal },
) {
  let url = await validateRemoteUrl(rawUrl);
  let response: Response | undefined;
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect += 1) {
    response = await fetch(url, {
      redirect: "manual",
      signal: options?.signal,
      headers: { Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml" },
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location || redirect === MAX_REDIRECTS) throw new Error("Remote image redirected too many times");
      url = await validateRemoteUrl(new URL(location, url).toString());
      continue;
    }
    break;
  }
  if (!response?.ok) throw new Error(`Remote image request failed (${response?.status ?? "unknown"})`);
  const rawType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ?? "";
  if (!ALLOWED_RASTER_TYPES.has(rawType) && rawType !== "image/svg+xml") {
    throw new Error("Remote URL did not return a supported image type");
  }
  let buffer = await readBoundedBody(response);
  let contentType = rawType;
  if (rawType === "image/svg+xml") {
    buffer = await rasterizeSvg(buffer);
    contentType = "image/png";
  }
  if (!buffer.length) throw new Error("Remote image was empty");
  const dimensions = await validateRasterDimensions(buffer);
  const pathname = url.pathname.split("/").filter(Boolean).pop() ?? "website-image";
  const baseName = decodeURIComponent(pathname).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 100);
  const extension = contentType === "image/png"
    ? "png"
    : contentType === "image/jpeg"
      ? "jpg"
      : contentType === "image/webp"
        ? "webp"
        : "gif";
  const name = baseName.includes(".") ? baseName : `${baseName}.${extension}`;
  return {
    finalUrl: url.toString(),
    name,
    contentType,
    bytes: buffer.byteLength,
    ...dimensions,
    dataUrl: `data:${contentType};base64,${buffer.toString("base64")}`,
  };
}
