import { z } from "zod";

const MAX_DEPTH = 32;

const envelopeRecordSchema = z.record(z.string(), z.unknown());

export function isAbsoluteFsPath(value: string): boolean {
  if (value.startsWith("/") && !value.startsWith("//")) {
    return (
      /^\/(?:tmp|var|home|root|data|datastore|opt|usr|etc|mnt|srv|app|config|usr)\b/i.test(value) ||
      /\.(?:txt|html|htm|json|png|ico|jpg|jpeg|gif|webp|bin|php|log|cs|js|ts)$/i.test(value)
    );
  }
  if (/^[A-Za-z]:[\\/]/.test(value)) return true;
  if (value.startsWith("\\\\")) return true;
  return false;
}

export function stripPathsInText(text: string): string {
  return text
    .split(/(\s+)/)
    .map((part) => (isAbsoluteFsPath(part) ? "[omitted-path]" : part))
    .join("");
}

const STACK_KEYS = new Set([
  "stack",
  "stacktrace",
  "stack_trace",
  "exception",
  "innerexception",
  "inner_exception",
]);

/** Drops stack traces. Library folder paths stay, because they are admin data. */
export function dropStackKeys(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value.map((item) => dropStackKeys(item, depth + 1));
  }
  if (typeof value !== "object") return null;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (STACK_KEYS.has(key.toLowerCase())) continue;
    out[key] = dropStackKeys(entry, depth + 1);
  }
  return out;
}

export function asJsonObject(value: unknown): Record<string, unknown> {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) out[key] = entry;
    return out;
  }
  if (Array.isArray(value)) return { items: value };
  if (typeof value === "string") return { text: value };
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return { value };
  }
  return { value: null };
}

export function messageFromErrorBody(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text);
    const message = pickMessage(parsed);
    return stripPathsInText(message);
  } catch {
    return stripPathsInText(text);
  }
}

function pickMessage(value: unknown): string {
  const record = envelopeRecordSchema.safeParse(value);
  if (!record.success) {
    return typeof value === "string" ? value : "request failed";
  }
  const body = record.data;
  const parts: string[] = [];
  for (const key of ["message", "title", "detail"]) {
    const entry = body[key];
    if (typeof entry === "string" && entry.trim().length > 0) parts.push(entry.trim());
  }
  const errors = envelopeRecordSchema.safeParse(body["errors"]);
  if (errors.success) {
    const first = Object.values(errors.data)[0];
    if (typeof first === "string") parts.push(first);
    else if (Array.isArray(first) && typeof first[0] === "string") parts.push(first[0]);
  }
  if (parts.length === 0) return "request failed";
  return parts.join(": ");
}
