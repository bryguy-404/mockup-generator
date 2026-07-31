const OPENAI_RESPONSES_URL = "https://api.openai.com/v1/responses";
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_MAX_WAIT_MS = 30 * 60 * 1_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
const MAX_CONSECUTIVE_POLL_FAILURES = 5;

type OpenAIResponseSnapshot = {
  id?: unknown;
  status?: unknown;
};

class OpenAIRequestError extends Error {
  status?: number;
  retryAfterMs?: number;

  constructor(
    message: string,
    options?: { status?: number; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "OpenAIRequestError";
    this.status = options?.status;
    this.retryAfterMs = options?.retryAfterMs;
  }
}

function readDuration(name: string, fallback: number, min: number, max: number) {
  const parsed = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new OpenAIRequestError("OpenAI background response was cancelled"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new OpenAIRequestError("OpenAI background response was cancelled"));
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function errorMessage(value: unknown, fallback: string) {
  if (!value || typeof value !== "object") return fallback;
  const details = value as {
    error?: { message?: unknown };
    incomplete_details?: { reason?: unknown };
  };
  const message = details.error?.message;
  if (typeof message === "string" && message.trim()) return message.trim();
  const incompleteReason = details.incomplete_details?.reason;
  return typeof incompleteReason === "string" && incompleteReason.trim()
    ? incompleteReason.trim()
    : fallback;
}

function retryAfterMs(value: string | null) {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

async function requestJson(args: {
  apiKey: string;
  method: "GET" | "POST";
  url: string;
  body?: Record<string, unknown>;
  timeoutMs: number;
  signal?: AbortSignal;
}) {
  const controller = new AbortController();
  let timedOut = false;
  const onAbort = () => controller.abort(args.signal?.reason);
  if (args.signal?.aborted) onAbort();
  args.signal?.addEventListener("abort", onAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, args.timeoutMs);
  try {
    const response = await fetch(args.url, {
      method: args.method,
      headers: {
        Authorization: `Bearer ${args.apiKey}`,
        ...(args.body ? { "Content-Type": "application/json" } : {}),
      },
      body: args.body ? JSON.stringify(args.body) : undefined,
      signal: controller.signal,
    });
    const json = (await response.json().catch(() => null)) as unknown;
    if (!response.ok) {
      throw new OpenAIRequestError(
        errorMessage(json, `OpenAI API error (${response.status})`),
        {
          status: response.status,
          retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
        },
      );
    }
    if (!json || typeof json !== "object") {
      throw new OpenAIRequestError("OpenAI returned an invalid JSON response");
    }
    return json;
  } catch (error) {
    if (error instanceof OpenAIRequestError) throw error;
    if (args.signal?.aborted) {
      throw new OpenAIRequestError("OpenAI background response was cancelled", {
        cause: error,
      });
    }
    if (timedOut) {
      throw new OpenAIRequestError(
        `OpenAI API request exceeded ${Math.round(args.timeoutMs / 1_000)} seconds`,
        { cause: error },
      );
    }
    throw new OpenAIRequestError("OpenAI API network request failed", {
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
    args.signal?.removeEventListener("abort", onAbort);
  }
}

function snapshot(value: unknown): OpenAIResponseSnapshot {
  return value && typeof value === "object"
    ? (value as OpenAIResponseSnapshot)
    : {};
}

function isPending(status: unknown) {
  return status === "queued" || status === "in_progress";
}

function isRetryablePollError(error: unknown) {
  if (!(error instanceof OpenAIRequestError)) return false;
  return (
    error.status === undefined ||
    error.status === 408 ||
    error.status === 409 ||
    error.status === 429 ||
    error.status >= 500
  );
}

async function cancelBackgroundResponse(
  apiKey: string,
  responseId: string,
  timeoutMs: number,
) {
  try {
    await requestJson({
      apiKey,
      method: "POST",
      url: `${OPENAI_RESPONSES_URL}/${encodeURIComponent(responseId)}/cancel`,
      timeoutMs,
    });
  } catch (error) {
    console.warn("[openai] could not cancel background response", {
      responseId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function createAndPollOpenAIResponse(args: {
  apiKey: string;
  body: Record<string, unknown>;
  deadlineAt?: number;
  signal?: AbortSignal;
}) {
  const pollIntervalMs = readDuration(
    "OPENAI_BACKGROUND_POLL_INTERVAL_MS",
    DEFAULT_POLL_INTERVAL_MS,
    500,
    30_000,
  );
  const maxWaitMs = readDuration(
    "OPENAI_BACKGROUND_MAX_WAIT_MS",
    DEFAULT_MAX_WAIT_MS,
    60_000,
    60 * 60 * 1_000,
  );
  const requestTimeoutMs = readDuration(
    "OPENAI_HTTP_REQUEST_TIMEOUT_MS",
    DEFAULT_REQUEST_TIMEOUT_MS,
    5_000,
    5 * 60 * 1_000,
  );

  const startedAt = Date.now();
  const deadlineAt = Math.min(
    startedAt + maxWaitMs,
    args.deadlineAt ?? Number.POSITIVE_INFINITY,
  );
  const initialRemainingMs = deadlineAt - Date.now();
  if (initialRemainingMs <= 0) {
    throw new Error("OpenAI background response reached the generation deadline");
  }

  let response = await requestJson({
    apiKey: args.apiKey,
    method: "POST",
    url: OPENAI_RESPONSES_URL,
    body: { ...args.body, background: true },
    timeoutMs: Math.max(1, Math.min(requestTimeoutMs, initialRemainingMs)),
    signal: args.signal,
  });
  const responseId = snapshot(response).id;
  if (typeof responseId !== "string" || !responseId) {
    throw new Error("OpenAI background response did not include an id");
  }

  let consecutiveFailures = 0;
  let nextProgressLogAt = startedAt + 30_000;
  console.log("[openai] background response started", {
    responseId,
    status: snapshot(response).status,
    model: typeof args.body.model === "string" ? args.body.model : undefined,
  });

  try {
    while (isPending(snapshot(response).status)) {
      let remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          "OpenAI background response reached the generation deadline",
        );
      }

      await sleep(Math.min(pollIntervalMs, remainingMs), args.signal);
      remainingMs = deadlineAt - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          "OpenAI background response reached the generation deadline",
        );
      }
      try {
        response = await requestJson({
          apiKey: args.apiKey,
          method: "GET",
          url: `${OPENAI_RESPONSES_URL}/${encodeURIComponent(responseId)}`,
          timeoutMs: Math.max(1, Math.min(requestTimeoutMs, remainingMs)),
          signal: args.signal,
        });
        consecutiveFailures = 0;
      } catch (error) {
        if (args.signal?.aborted) throw error;
        if (Date.now() >= deadlineAt) {
          throw new Error(
            "OpenAI background response reached the generation deadline",
          );
        }
        consecutiveFailures += 1;
        if (
          !isRetryablePollError(error) ||
          consecutiveFailures > MAX_CONSECUTIVE_POLL_FAILURES
        ) {
          throw error;
        }
        const backoffMs = Math.min(
          error instanceof OpenAIRequestError && error.retryAfterMs !== undefined
            ? error.retryAfterMs
            : 1_000 * 2 ** (consecutiveFailures - 1),
          30_000,
          Math.max(0, deadlineAt - Date.now()),
        );
        console.warn("[openai] status poll failed; retrying", {
          responseId,
          attempt: consecutiveFailures,
          retryInMs: backoffMs,
          error: error instanceof Error ? error.message : String(error),
        });
        await sleep(backoffMs, args.signal);
        continue;
      }

      if (Date.now() >= nextProgressLogAt) {
        console.log("[openai] background response still running", {
          responseId,
          status: snapshot(response).status,
          elapsedSec: Math.round((Date.now() - startedAt) / 1_000),
        });
        nextProgressLogAt = Date.now() + 30_000;
      }
    }

    const status = snapshot(response).status;
    if (status !== "completed") {
      throw new Error(
        `OpenAI background response ended with status ${typeof status === "string" ? status : "unknown"}: ${errorMessage(response, "no error details")}`,
      );
    }

    console.log("[openai] background response finished", {
      responseId,
      status,
      elapsedSec: Math.round((Date.now() - startedAt) / 1_000),
    });
    return response;
  } catch (error) {
    if (isPending(snapshot(response).status)) {
      await cancelBackgroundResponse(
        args.apiKey,
        responseId,
        Math.min(requestTimeoutMs, 5_000),
      );
    }
    throw error;
  }
}
