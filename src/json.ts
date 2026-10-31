import { z } from "zod";
import { API_PREFIX } from "./constants.js";
import { ConnectorError } from "./errors.js";
import type { QueryMap, QueryValue } from "./http.js";

export const jsonObjectSchema = z.record(z.string(), z.unknown());
export const jsonValueSchema = z.unknown();

export function definedQuery(
  record: Readonly<Record<string, QueryValue | undefined>>,
): QueryMap | undefined {
  const out: Record<string, QueryValue> = {};
  for (const key of Object.keys(record).sort()) {
    const value = record[key];
    if (value === undefined) continue;
    out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

export function fillOpenApiPath(
  openApiPath: string,
  params: Readonly<Record<string, string | number>>,
): string {
  if (!openApiPath.startsWith("/")) {
    throw new ConnectorError("input", "OpenAPI path must start with /.");
  }
  const filled = openApiPath.replace(/\{([^}]+)\}/g, (_, name: string) => {
    const value = params[name];
    if (value === undefined || value === "") {
      throw new ConnectorError("input", `Missing path parameter ${name}.`);
    }
    return encodeURIComponent(String(value));
  });
  if (filled.includes("{") || filled.includes("}")) {
    throw new ConnectorError("input", "Request path still contains a template marker.");
  }
  const relative = filled.replace(/^\/+/, "");
  if (API_PREFIX.length === 0) return relative;
  return [API_PREFIX, relative].filter((part) => part.length > 0).join("/");
}
