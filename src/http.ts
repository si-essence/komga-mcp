import type { ZodType } from "zod";
import type { BaseUrl, Secret } from "./brand.js";
import { TtlCache } from "./cache.js";
import { ConnectorError } from "./errors.js";
import type { Logger } from "./log.js";
import { messageFromErrorBody } from "./parse.js";
import type { RateLimiter } from "./rate-limit.js";
import { redact, redactLiterals, redactUnknown, stripUrls } from "./redact.js";

export const API_KEY_HEADER = "X-API-Key";
const MAX_BODY = 1_000_000;

export type QueryPrimitive = string | number | boolean;
export type QueryValue = QueryPrimitive | readonly QueryPrimitive[];
export type QueryMap = Readonly<Record<string, QueryValue>>;

export interface JsonGet {
  path: string;
  query: QueryMap | undefined;
  ttlSec: number;
  /** When false, secret field names stay so a one-time reveal can restore them. */
  fieldRedact?: boolean;
  extraHeaders?: Readonly<Record<string, string>>;
}

export interface JsonWrite {
  path: string;
  query: QueryMap | undefined;
  body: unknown;
  fieldRedact?: boolean;
  extraHeaders?: Readonly<Record<string, string>>;
}

export interface EmptyWrite {
  path: string;
  query: QueryMap | undefined;
  fieldRedact?: boolean;
  extraHeaders?: Readonly<Record<string, string>>;
}

export interface HttpClientOptions {
  baseUrl: BaseUrl;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  secrets: string[];
  cache: TtlCache;
  limiter: RateLimiter;
  userAgent: string;
  logger: Logger;
  apiKey: Secret | undefined;
  username: string | undefined;
  password: Secret | undefined;
  label: string;
}

type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export class HttpClient {
  private readonly baseUrl: BaseUrl;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly secrets: string[];
  private readonly cache: TtlCache;
  private readonly limiter: RateLimiter;
  private readonly userAgent: string;
  private readonly logger: Logger;
  private readonly apiKey: Secret | undefined;
  private readonly username: string | undefined;
  private readonly password: Secret | undefined;
  private readonly label: string;

  constructor(options: HttpClientOptions) {
    this.baseUrl = options.baseUrl;
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs;
    this.secrets = options.secrets;
    this.cache = options.cache;
    this.limiter = options.limiter;
    this.userAgent = options.userAgent;
    this.logger = options.logger;
    this.apiKey = options.apiKey;
    this.username = options.username;
    this.password = options.password;
    this.label = options.label;
  }

  async getJson<T>(request: JsonGet, schema: ZodType<T>): Promise<T> {
    const url = this.buildUrl(request.path, request.query);
    const cacheKey = `GET ${url.origin}${url.pathname}${url.search}`;
    if (request.ttlSec > 0) {
      const cached = this.readCache(cacheKey, schema);
      if (cached !== undefined) return cached;
    }
    const response = await this.dispatch(
      url,
      "GET",
      undefined,
      "application/json",
      undefined,
      0,
      request.extraHeaders,
    );
    const text = await readLimited(response, this.label);
    const keepFields = request.fieldRedact === false;
    if (isRedirect(response.status)) {
      return this.accept(cacheKey, 0, schema, redirectBody(response, this.secrets), keepFields);
    }
    if (!response.ok) throw this.httpError(response, text);
    this.rejectHtml(text, response.status);
    const json = parseFlexibleBody(text, response.status);
    return this.accept(cacheKey, request.ttlSec, schema, json, keepFields);
  }

  async postJson<T>(request: JsonWrite, schema: ZodType<T>): Promise<T> {
    return this.sendJson("POST", request, schema);
  }

  async putJson<T>(request: JsonWrite, schema: ZodType<T>): Promise<T> {
    return this.sendJson("PUT", request, schema);
  }

  async patchJson<T>(request: JsonWrite, schema: ZodType<T>): Promise<T> {
    return this.sendJson("PATCH", request, schema);
  }

  async deleteJson<T>(request: JsonWrite, schema: ZodType<T>): Promise<T> {
    return this.sendJson("DELETE", request, schema);
  }

  async postEmpty(request: EmptyWrite): Promise<{ status: number; body: unknown }> {
    return this.sendEmpty("POST", request);
  }

  async putEmpty(request: EmptyWrite): Promise<{ status: number; body: unknown }> {
    return this.sendEmpty("PUT", request);
  }

  async patchEmpty(request: EmptyWrite): Promise<{ status: number; body: unknown }> {
    return this.sendEmpty("PATCH", request);
  }

  async delete(request: EmptyWrite): Promise<{ status: number; body: unknown }> {
    return this.sendEmpty("DELETE", request);
  }

  private async sendJson<T>(method: Method, request: JsonWrite, schema: ZodType<T>): Promise<T> {
    const bodyText = this.serializeBody(request.body);
    const url = this.buildUrl(request.path, request.query);
    const response = await this.dispatch(
      url,
      method,
      bodyText,
      "application/json",
      bodyText === undefined ? undefined : "application/json",
      0,
      request.extraHeaders,
    );
    const text = await readLimited(response, this.label);
    const keepFields = request.fieldRedact === false;
    if (isRedirect(response.status)) {
      const accepted = this.accept(
        `${method} ${url.pathname}`,
        0,
        schema,
        redirectBody(response, this.secrets),
        keepFields,
      );
      this.cache.clear();
      return accepted;
    }
    if (!response.ok) throw this.httpError(response, text);
    this.rejectHtml(text, response.status);
    const json = parseFlexibleBody(text, response.status);
    const accepted = this.accept(`${method} ${url.pathname}`, 0, schema, json, keepFields);
    this.cache.clear();
    return accepted;
  }

  private async sendEmpty(
    method: Method,
    request: EmptyWrite,
  ): Promise<{ status: number; body: unknown }> {
    const url = this.buildUrl(request.path, request.query);
    const response = await this.dispatch(
      url,
      method,
      undefined,
      "*/*",
      undefined,
      0,
      request.extraHeaders,
    );
    const text = await readLimited(response, this.label);
    if (isRedirect(response.status)) {
      this.cache.clear();
      return { status: response.status, body: redirectBody(response, this.secrets) };
    }
    if (!response.ok) throw this.httpError(response, text);
    this.cache.clear();
    const parsedBody = parseFlexibleBody(text, response.status);
    const body =
      text.trim().length === 0
        ? { ok: true }
        : request.fieldRedact === false
          ? redactLiterals(parsedBody, this.secrets)
          : redactUnknown(parsedBody, this.secrets);
    return { status: response.status, body };
  }

  private serializeBody(body: unknown): string | undefined {
    if (body === undefined) return undefined;
    let text: string;
    try {
      text = JSON.stringify(body);
    } catch {
      throw new ConnectorError("input", "Request body could not be serialized as JSON.");
    }
    if (text.length > MAX_BODY) {
      throw new ConnectorError("input", "Request body was too large.");
    }
    return text;
  }

  private readCache<T>(cacheKey: string, schema: ZodType<T>): T | undefined {
    const cached = this.cache.get(cacheKey);
    if (cached === undefined) return undefined;
    const parsed = schema.safeParse(cached);
    if (parsed.success) return parsed.data;
    this.cache.delete(cacheKey);
    return undefined;
  }

  rememberSecret(value: string): void {
    this.remember(value);
  }

  private accept<T>(
    cacheKey: string,
    ttlSec: number,
    schema: ZodType<T>,
    json: unknown,
    keepFields = false,
  ): T {
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      throw new ConnectorError(
        "upstream",
        `${this.label} response did not match the expected shape.`,
      );
    }
    const scrubbed = keepFields
      ? redactLiterals(parsed.data, this.secrets)
      : redactUnknown(parsed.data, this.secrets);
    const safe = schema.safeParse(scrubbed);
    if (!safe.success) {
      throw new ConnectorError("upstream", `${this.label} response could not be returned safely.`);
    }
    if (ttlSec > 0) this.cache.set(cacheKey, safe.data, ttlSec);
    return safe.data;
  }

  private rejectHtml(text: string, status: number): void {
    if (/<!doctype html|<html[\s>]/i.test(text)) {
      throw new ConnectorError(
        "upstream",
        `${this.label} HTTP ${status}: the service returned an error page instead of JSON.`,
      );
    }
  }

  private buildUrl(path: string, query: QueryMap | undefined): URL {
    if (
      path.length === 0 ||
      path.startsWith("/") ||
      path.includes("?") ||
      path.includes("#") ||
      path.includes("\\") ||
      path.includes("..")
    ) {
      throw new ConnectorError("input", "Request path must be a relative path.");
    }
    this.assertNoSecret(path, "Refusing to place a secret in the request URL.");
    const base = new URL(`${this.baseUrl}/`);
    const url = new URL(path, base);
    if (url.origin !== base.origin) {
      throw new ConnectorError("input", "Request path must stay on the configured base URL.");
    }
    if (query !== undefined) {
      for (const key of Object.keys(query).sort()) {
        const value = query[key];
        if (value === undefined) continue;
        if (Array.isArray(value)) {
          for (const item of value) {
            const text = String(item);
            this.assertNoSecret(text, "Refusing to place a secret in the request URL.");
            url.searchParams.append(key, text);
          }
        } else {
          const text = String(value);
          this.assertNoSecret(text, "Refusing to place a secret in the request URL.");
          url.searchParams.set(key, text);
        }
      }
    }
    return url;
  }

  private assertNoSecret(value: string, message: string): void {
    for (const secret of this.secrets) {
      if (
        secret.length >= 8 &&
        (value.includes(secret) || value.includes(encodeURIComponent(secret)))
      ) {
        this.logger.error(message);
        throw new ConnectorError("config", message);
      }
    }
  }

  private async dispatch(
    url: URL,
    method: Method,
    body: BodyInit | undefined,
    accept: string,
    contentType: string | undefined,
    _attempt: number,
    extraHeaders?: Readonly<Record<string, string>>,
  ): Promise<Response> {
    this.limiter.acquire();
    const headers = new Headers();
    headers.set("accept", accept);
    headers.set("user-agent", this.userAgent);
    this.applyAuth(headers);
    if (contentType !== undefined) headers.set("content-type", contentType);
    if (extraHeaders !== undefined) {
      for (const [name, value] of Object.entries(extraHeaders)) {
        headers.set(name, value);
        if (value.length >= 8) this.remember(value);
      }
    }
    try {
      return await this.fetchImpl(url, {
        method,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(body === undefined ? {} : { body }),
      });
    } catch (error) {
      if (error instanceof ConnectorError) throw error;
      const name = error instanceof Error ? error.name : "";
      if (name === "TimeoutError" || name === "AbortError") {
        const seconds = Math.max(1, Math.round(this.timeoutMs / 1000));
        throw new ConnectorError("timeout", `${this.label} request timed out after ${seconds}s.`);
      }
      const raw = error instanceof Error ? error.message : "network error";
      const safe = publicSnippet(raw, this.secrets);
      this.logger.error(`${this.label} request failed: ${safe}`);
      throw new ConnectorError("network", `${this.label} request failed: ${safe}`);
    }
  }

  private applyAuth(headers: Headers): void {
    if (this.apiKey !== undefined) {
      headers.set(API_KEY_HEADER, this.apiKey);
      return;
    }
    if (this.username !== undefined && this.password !== undefined) {
      const token = Buffer.from(`${this.username}:${this.password}`, "utf8").toString("base64");
      headers.set("authorization", `Basic ${token}`);
      return;
    }
    throw new ConnectorError(
      "config",
      "KOMGA_API_KEY is not set. Set an API key, or KOMGA_USERNAME and KOMGA_PASSWORD.",
    );
  }

  private remember(value: string): void {
    if (value.length >= 8 && !this.secrets.includes(value)) this.secrets.push(value);
  }

  private httpError(response: Response, text: string): ConnectorError {
    const snippet = publicSnippet(messageFromErrorBody(text), this.secrets);
    const detail = snippet.length > 0 ? `: ${snippet}` : "";
    const status = response.status;
    if (status === 401) {
      return new ConnectorError("unauthorized", `${this.label} HTTP 401${detail}`);
    }
    if (status === 403) {
      return new ConnectorError("forbidden", `${this.label} HTTP 403${detail}`);
    }
    if (status === 400 || status === 422) {
      return new ConnectorError("input", `${this.label} HTTP ${status}${detail}`);
    }
    if (status === 404) {
      return new ConnectorError("not_found", `${this.label} HTTP 404${detail}`);
    }
    if (status === 429) {
      const retry = retryAfterSeconds(response);
      const wait = retry === null ? "" : ` retry after ${retry}s`;
      return new ConnectorError("rate_limit", `${this.label} HTTP 429${detail}${wait}`, retry);
    }
    if (status >= 500) {
      this.logger.error(`${this.label} HTTP ${status}${detail}`);
      return new ConnectorError("upstream", `${this.label} HTTP ${status} server error${detail}`);
    }
    this.logger.error(`${this.label} HTTP ${status}${detail}`);
    return new ConnectorError("upstream", `${this.label} HTTP ${status}${detail}`);
  }
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function redirectBody(response: Response, secrets: readonly string[]): Record<string, unknown> {
  const location = response.headers.get("location");
  return {
    redirected: true,
    status: response.status,
    ...(location === null ? {} : { location: redact(location, secrets) }),
  };
}

function publicSnippet(text: string, secrets: readonly string[]): string {
  return stripUrls(redact(text, secrets)).replace(/\s+/g, " ").trim().slice(0, 180);
}

function parseFlexibleBody(text: string, status: number): unknown {
  if (text.trim().length === 0) {
    return { ok: true, status };
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { text: text.slice(0, 100_000), status };
  }
}

async function readLimited(response: Response, label: string): Promise<string> {
  const declared = response.headers.get("content-length");
  if (declared !== null && /^[0-9]+$/.test(declared) && Number(declared) > MAX_BODY) {
    await response.body?.cancel().catch(() => undefined);
    throw new ConnectorError("upstream", `${label} response was too large to parse.`);
  }
  let text = "";
  try {
    text = await response.text();
  } catch {
    throw new ConnectorError("upstream", `${label} response could not be read.`);
  }
  if (text.length > MAX_BODY) {
    throw new ConnectorError("upstream", `${label} response was too large to parse.`);
  }
  return text;
}

function retryAfterSeconds(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (raw === null) return null;
  if (/^[0-9]+$/.test(raw)) {
    const seconds = Number(raw);
    return seconds > 0 ? seconds : null;
  }
  const when = Date.parse(raw);
  if (Number.isNaN(when)) return null;
  return Math.max(1, Math.ceil((when - Date.now()) / 1000));
}
