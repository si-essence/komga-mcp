import { z } from "zod";
import { brandBaseUrl, brandSecret, type BaseUrl, type Secret } from "./brand.js";
import { CONNECTOR_NAME, CONNECTOR_VERSION } from "./constants.js";
import { ConnectorError } from "./errors.js";
import { parseToolsets } from "./operations.js";
import { fixedError } from "./zod-messages.js";

const invalid = fixedError("invalid");

const EnvSchema = z.object({
  KOMGA_API_KEY: z
    .string({ error: invalid })
    .trim()
    .min(8, { error: invalid })
    .max(512, { error: invalid })
    .optional(),
  KOMGA_USERNAME: z
    .string({ error: invalid })
    .trim()
    .min(1, { error: invalid })
    .max(256, { error: invalid })
    .optional(),
  KOMGA_PASSWORD: z
    .string({ error: invalid })
    .min(1, { error: invalid })
    .max(512, { error: invalid })
    .optional(),
  KOMGA_URL: z.url({ error: invalid }),
  KOMGA_ALLOW_WRITES: z.string({ error: invalid }).optional(),
  KOMGA_TOOLSETS: z.string({ error: invalid }).optional(),
  KOMGA_PER_MINUTE: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  KOMGA_TIMEOUT_MS: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  KOMGA_CONTACT: z
    .string({ error: invalid })
    .trim()
    .min(1, { error: invalid })
    .max(120, { error: invalid })
    .optional(),
  MCP_TRANSPORT: z.enum(["stdio", "http"], { error: invalid }).optional(),
  PORT: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
  KOMGA_CACHE_TTL_SEC: z
    .string({ error: invalid })
    .regex(/^[0-9]+$/, { error: invalid })
    .optional(),
});

export interface Config {
  apiKey: Secret | undefined;
  username: string | undefined;
  password: Secret | undefined;
  baseUrl: BaseUrl;
  allowWrites: boolean;
  toolsets: readonly string[];
  perMinute: number;
  timeoutMs: number;
  contact: string;
  transport: "stdio" | "http";
  port: number;
  cacheTtlSec: number;
  userAgent: string;
}

function hasControlChar(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function blank(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function read(env: NodeJS.ProcessEnv, name: string): string | undefined {
  return blank(env[name]);
}

function issueSummary(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path =
        issue.path.length === 0 ? "(root)" : issue.path.map((part) => String(part)).join(".");
      return `${path} (${issue.code})`;
    })
    .join("; ");
}

function boundedInt(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  if (raw === undefined) return fallback;
  const parsed = z.number().int().min(min).max(max).safeParse(Number(raw));
  if (!parsed.success) {
    throw new ConnectorError("config", `Invalid environment: ${field} (out_of_range).`);
  }
  return parsed.data;
}

function userAgentFor(contact: string): string {
  const clean = contact
    .replace(/[\r\n]+/g, " ")
    .trim()
    .slice(0, 120);
  return `${CONNECTOR_NAME}/${CONNECTOR_VERSION} (${clean.length > 0 ? clean : "contact@example.com"})`;
}

function normalizeBaseUrl(value: string): BaseUrl {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConnectorError("config", "Invalid environment: KOMGA_URL (invalid_url).");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ConnectorError("config", "Invalid environment: KOMGA_URL (invalid_url).");
  }
  if (url.username !== "" || url.password !== "") {
    throw new ConnectorError("config", "Invalid environment: KOMGA_URL (userinfo).");
  }
  if (url.search !== "" || url.hash !== "") {
    throw new ConnectorError("config", "Invalid environment: KOMGA_URL (query_or_hash).");
  }
  return brandBaseUrl(value.replace(/\/+$/, ""));
}

export function loadConfig(env: NodeJS.ProcessEnv, argv: readonly string[]): Config {
  const urlRaw = read(env, "KOMGA_URL");
  if (urlRaw === undefined) {
    throw new ConnectorError(
      "config",
      "Invalid environment: KOMGA_URL (required). Set it to your self-hosted Komga origin, for example http://127.0.0.1:25600.",
    );
  }

  const parsed = EnvSchema.safeParse({
    KOMGA_API_KEY: read(env, "KOMGA_API_KEY"),
    KOMGA_USERNAME: read(env, "KOMGA_USERNAME"),
    KOMGA_PASSWORD: read(env, "KOMGA_PASSWORD"),
    KOMGA_URL: urlRaw,
    KOMGA_ALLOW_WRITES: read(env, "KOMGA_ALLOW_WRITES"),
    KOMGA_TOOLSETS: read(env, "KOMGA_TOOLSETS"),
    KOMGA_PER_MINUTE: read(env, "KOMGA_PER_MINUTE"),
    KOMGA_TIMEOUT_MS: read(env, "KOMGA_TIMEOUT_MS"),
    KOMGA_CONTACT: read(env, "KOMGA_CONTACT"),
    MCP_TRANSPORT: read(env, "MCP_TRANSPORT"),
    PORT: read(env, "PORT"),
    KOMGA_CACHE_TTL_SEC: read(env, "KOMGA_CACHE_TTL_SEC"),
  });
  if (!parsed.success) {
    throw new ConnectorError("config", `Invalid environment: ${issueSummary(parsed.error)}.`);
  }

  const data = parsed.data;
  const apiKey = data.KOMGA_API_KEY === undefined ? undefined : brandSecret(data.KOMGA_API_KEY);
  const password = data.KOMGA_PASSWORD === undefined ? undefined : brandSecret(data.KOMGA_PASSWORD);
  const username = data.KOMGA_USERNAME;
  if ((username === undefined) !== (password === undefined)) {
    throw new ConnectorError(
      "config",
      "Invalid environment: KOMGA_USERNAME and KOMGA_PASSWORD must be set together.",
    );
  }
  const baseUrl = normalizeBaseUrl(data.KOMGA_URL);
  const contact = data.KOMGA_CONTACT ?? "contact@example.com";
  if (hasControlChar(contact)) {
    throw new ConnectorError("config", "Invalid environment: KOMGA_CONTACT (control_character).");
  }
  const userAgent = userAgentFor(contact);
  const secretValues = [apiKey, password].filter((value): value is Secret => value !== undefined);
  for (const secret of secretValues) {
    if (baseUrl.includes(secret)) {
      throw new ConnectorError("config", "Invalid environment: KOMGA_URL (contains_secret).");
    }
    if (contact.includes(secret) || userAgent.includes(secret)) {
      throw new ConnectorError("config", "Invalid environment: KOMGA_CONTACT (contains_secret).");
    }
    if (username !== undefined && username.includes(secret)) {
      throw new ConnectorError("config", "Invalid environment: KOMGA_USERNAME (contains_secret).");
    }
  }

  const envTransport = data.MCP_TRANSPORT ?? "stdio";
  const transport = argv.includes("--http") ? "http" : envTransport;
  const allowWrites = data.KOMGA_ALLOW_WRITES === "true";
  let toolsets: readonly string[];
  try {
    toolsets = parseToolsets(data.KOMGA_TOOLSETS);
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    throw new ConnectorError("config", "Invalid environment: KOMGA_TOOLSETS.");
  }

  return {
    apiKey,
    username,
    password,
    baseUrl,
    allowWrites,
    toolsets,
    perMinute: boundedInt(data.KOMGA_PER_MINUTE, 30, 1, 10_000, "KOMGA_PER_MINUTE"),
    timeoutMs: boundedInt(data.KOMGA_TIMEOUT_MS, 20_000, 100, 120_000, "KOMGA_TIMEOUT_MS"),
    contact,
    transport,
    port: boundedInt(data.PORT, 3000, 1, 65_535, "PORT"),
    cacheTtlSec: boundedInt(data.KOMGA_CACHE_TTL_SEC, 60, 0, 86_400, "KOMGA_CACHE_TTL_SEC"),
    userAgent,
  };
}
