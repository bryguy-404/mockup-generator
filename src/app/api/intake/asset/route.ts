import { NextResponse } from "next/server";
import { fetchRemoteImage } from "@/lib/remote-image";

export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(request: Request) {
  let body: { url?: unknown };
  try {
    body = (await request.json()) as { url?: unknown };
  } catch {
    return NextResponse.json({ error: "Request body must be JSON" }, { status: 400 });
  }
  if (typeof body.url !== "string" || body.url.length > 4_096) {
    return NextResponse.json({ error: "A valid remote image URL is required" }, { status: 400 });
  }
  try {
    const image = await fetchRemoteImage(body.url, { signal: request.signal });
    return NextResponse.json(image);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not import remote image";
    const status = /private|reserved|not allowed|supported|larger|invalid/i.test(message) ? 400 : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
