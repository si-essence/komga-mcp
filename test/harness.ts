import { loadConfig } from "../src/config.js";
import { API_KEY_HEADER } from "../src/http.js";
import { createRuntime, type Runtime } from "../src/runtime.js";

export const TOKEN = "super-secret/key+value=99";
export const BASE = "https://komga.test";

export function env(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    KOMGA_URL: BASE,
    KOMGA_API_KEY: TOKEN,
    KOMGA_CACHE_TTL_SEC: "0",
    KOMGA_ALLOW_WRITES: "true",
    KOMGA_TOOLSETS: "all",
    ...extra,
  };
}

export function runtimeFor(
  fetchImpl: typeof fetch,
  extra: NodeJS.ProcessEnv = {},
  now?: () => number,
): Runtime {
  return createRuntime(loadConfig(env(extra), []), {
    fetchImpl,
    ...(now === undefined ? {} : { now }),
  });
}

export function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

export interface CapturedRequest {
  method: string;
  url: string;
  apiKey: string | null;
  authorization: string | null;
  body: unknown;
}

export function capturedFrom(input: RequestInfo | URL, init?: RequestInit): CapturedRequest {
  const headers = new Headers(init?.headers);
  let body: unknown;
  if (init?.body === undefined) body = undefined;
  else if (typeof init.body === "string") {
    try {
      body = JSON.parse(init.body) as unknown;
    } catch {
      body = init.body;
    }
  } else body = init.body;
  return {
    method: init?.method ?? "GET",
    url: requestUrl(input),
    apiKey: headers.get(API_KEY_HEADER),
    authorization: headers.get("authorization"),
    body,
  };
}

export function jsonFetch(impl: (captured: CapturedRequest) => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: CapturedRequest[];
} {
  const calls: CapturedRequest[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const captured = capturedFrom(input, init);
    calls.push(captured);
    return Promise.resolve(impl(captured));
  };
  return { fetchImpl, calls };
}

export function expectAuth(captured: CapturedRequest): void {
  if (captured.apiKey !== TOKEN) {
    throw new Error("missing x-api-key header");
  }
  if (captured.url.includes(TOKEN) || captured.url.includes(encodeURIComponent(TOKEN))) {
    throw new Error("token leaked into the url");
  }
}

export function jsonResponse(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
