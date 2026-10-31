#!/usr/bin/env node
/**
 * Generate src/operations.ts from komga.openapi.json (Komga 1.29.2, MIT,
 * gotson/komga). Run: node scripts/gen-operations.mjs
 *
 * GET is a read. POST, PUT, PATCH, and DELETE are writes unless the path is in
 * READ_POST_PATHS. A GET in GET_SIDE_EFFECT_PATHS is a write because the
 * server changes state.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const specPath = join(root, "komga.openapi.json");

const TOOLSET_OVERRIDE = {};

export const DEFAULT_TOOLSETS = [
  "libraries",
  "series",
  "books",
  "collections",
  "readlists",
  "referential_metadata",
  "management",
];

/** POST paths that only query. Each path was read from the 1.29.2 spec. */
export const READ_POST_PATHS = [
  "/api/v1/books/list",
  "/api/v1/filesystem",
  "/api/v1/series/list",
  "/api/v1/series/list/alphabetical-groups",
];

/** GET paths whose summaries document a server-side change. */
export const GET_SIDE_EFFECT_PATHS = ["/api/logout", "/api/v1/login/set-cookie"];

const READ_POST_FORBIDDEN =
  /delete|remove|update|create|scan|analyze|refresh|clear|reset|login|register/i;

const METHODS = ["get", "post", "put", "patch", "delete"];

/**
 * @param {string} value
 */
export function slug(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .toLowerCase();
}

/**
 * @param {string} tag
 */
export function toolsetForTag(tag) {
  return TOOLSET_OVERRIDE[tag] ?? slug(tag);
}

/**
 * @param {string} method
 * @param {string} path
 * @param {string} tag
 */
export function actionFrom(method, path, tag) {
  const parts = path.split("/").filter(Boolean);
  if (parts[0]?.toLowerCase() === "api") parts.shift();
  if (parts[0] !== undefined && /^v\d+$/i.test(parts[0])) parts.shift();
  if (parts[0] !== undefined && slug(parts[0]) === slug(tag)) parts.shift();
  const statics = parts.filter((part) => !part.startsWith("{")).map((part) => slug(part));
  const verb = method.toLowerCase();
  const name = [verb, ...statics].filter(Boolean).join("_");
  return name.length > 0 ? name : verb;
}

/**
 * @param {string} method
 * @param {string} path
 */
export function classifyWrite(method, path) {
  if (method === "GET") return GET_SIDE_EFFECT_PATHS.includes(path);
  if (method === "POST" && READ_POST_PATHS.includes(path)) return false;
  return true;
}

/**
 * @param {object} op
 */
function responseContent(op) {
  const ok = op.responses?.["200"] ?? op.responses?.["201"] ?? op.responses?.["204"] ?? {};
  return ok.content ?? {};
}

/**
 * @param {string} method
 * @param {string} path
 * @param {string} tag
 * @param {object} op
 * @returns {string | null}
 */
export function exclusionReason(method, path, tag, op) {
  const lower = path.toLowerCase();
  const requestTypes = Object.keys(op.requestBody?.content ?? {});
  if (requestTypes.some((key) => key.includes("multipart"))) {
    return "Multipart file upload. The tool sends JSON and cannot attach a file part.";
  }
  const responseTypes = Object.keys(responseContent(op));
  const binaryType = responseTypes.some((key) =>
    /image\/|octet-stream|zip|font\/|application\/pdf/i.test(key),
  );
  if (binaryType) {
    return "Binary response (image, zip, font, or file bytes). An MCP tool cannot carry it usefully.";
  }
  if (/\/pages\/\{pagenumber\}(\/raw|\/thumbnail)?$/.test(lower)) {
    return "Book page image, raw page bytes, or page thumbnail. The tool speaks JSON only.";
  }
  if (/\/thumbnail$/.test(lower)) {
    return "Poster or thumbnail image bytes. List endpoints that return JSON stay.";
  }
  if (lower.includes("/fonts/resource")) {
    return "Font file or CSS bytes for the epub reader.";
  }
  if (lower.includes("/transient-books/") && lower.includes("/pages/")) {
    return "Transient book page bytes.";
  }
  if (/\/books\/\{bookid\}\/resource\//.test(lower)) {
    return "Raw epub resource bytes.";
  }
  if (/\/file(\/\*)?$/.test(lower) && method === "GET") {
    return "File download (book, series zip, or readlist archive).";
  }
  void tag;
  return null;
}

/**
 * @param {string} method
 * @param {string} path
 * @param {string} summary
 * @param {boolean} write
 */
function warningsFor(method, path, summary, write) {
  if (!write) return [];
  const lower = `${path} ${summary}`.toLowerCase();
  /** @type {string[]} */
  const out = [];
  if (method === "DELETE" || /\/delete/.test(lower)) {
    if (lower.includes("librar")) {
      out.push("This deletes a library and the series inside it. It may be irreversible.");
    } else if (lower.includes("series")) {
      out.push("This deletes a series. It may be irreversible.");
    } else if (lower.includes("/file")) {
      out.push("This deletes files on disk. It may be irreversible.");
    } else if (lower.includes("collection")) {
      out.push("This deletes a collection. It may be irreversible.");
    } else if (lower.includes("readlist")) {
      out.push("This deletes a readlist. It may be irreversible.");
    } else if (lower.includes("user")) {
      out.push("This deletes a user. It may be irreversible.");
    } else {
      out.push("This deletes data on the Komga server. It may be irreversible.");
    }
  }
  if (/scan|analyze|refresh|empty-trash|empty trash|clear task/.test(lower)) {
    out.push("This starts a scan, analyze, refresh, trash empty, or other server task.");
  }
  if (/\/users\b/.test(lower) && method !== "GET") {
    out.push("This creates a user or changes roles, libraries, or a password.");
  }
  if (/api-keys/.test(lower) && method !== "GET") {
    out.push(
      "This creates or deletes an API key. A new key is shown only once. Later reads redact it.",
    );
  }
  if (/password/.test(lower) && method !== "GET") {
    out.push("This changes a password.");
  }
  if (lower.includes("/api/v1/settings") && method !== "GET") {
    out.push("This updates Komga server settings.");
  }
  if (lower.includes("/claim") && method === "POST") {
    out.push("This claims a fresh server and creates the first admin.");
  }
  if (/oauth|set-cookie|logout/.test(lower)) {
    out.push("This starts or ends a session, or changes OAuth sign-in.");
  }
  if (method === "GET") {
    out.push("This GET changes server state. It is gated like a write.");
  }
  return [...new Set(out)];
}

/**
 * @param {string} method
 * @param {string} path
 * @param {readonly string[]} warnings
 */
function isDestructive(method, path, warnings) {
  if (method === "DELETE") return true;
  return warnings.some((line) =>
    /deletes|scan, analyze|API key|password|server settings|claims a fresh|session/.test(line),
  );
}

/**
 * @param {object} spec
 * @param {unknown} schema
 * @param {number} depth
 * @param {Set<string>} seen
 * @returns {unknown}
 */
function resolveSchema(spec, schema, depth, seen) {
  if (!schema || typeof schema !== "object" || depth > 5) return { type: "object" };
  const node = /** @type {Record<string, unknown>} */ (schema);
  if (typeof node.$ref === "string") {
    const name = node.$ref.split("/").pop() ?? "";
    if (seen.has(name)) return { type: "object" };
    const next = new Set(seen);
    next.add(name);
    const target = spec.components?.schemas?.[name];
    return resolveSchema(spec, target ?? { type: "object" }, depth + 1, next);
  }
  if (Array.isArray(node.allOf) && node.allOf.length > 0) {
    return resolveSchema(spec, node.allOf[0], depth + 1, seen);
  }
  if (Array.isArray(node.oneOf) && node.oneOf.length > 0) {
    return resolveSchema(spec, node.oneOf[0], depth + 1, seen);
  }
  if (Array.isArray(node.anyOf) && node.anyOf.length > 0) {
    return resolveSchema(spec, node.anyOf[0], depth + 1, seen);
  }
  return node;
}

/**
 * @param {unknown} schema
 */
function typeLabel(schema) {
  if (!schema || typeof schema !== "object") return "unknown";
  const node = /** @type {Record<string, unknown>} */ (schema);
  if (Array.isArray(node.enum) && node.enum.length > 0) return `enum:${String(node.enum[0])}`;
  if (node.type === "array") return "array";
  if (typeof node.type === "string") return node.type;
  if (node.properties) return "object";
  return "unknown";
}

/**
 * @param {object} spec
 * @param {unknown} schema
 * @param {number} depth
 * @returns {unknown}
 */
function sampleFromSchema(spec, schema, depth = 0) {
  const node = resolveSchema(spec, schema, 0, new Set());
  if (!node || typeof node !== "object" || depth > 4) return {};
  const record = /** @type {Record<string, unknown>} */ (node);
  if (record.type === "array") {
    return [sampleFromSchema(spec, record.items ?? { type: "string" }, depth + 1)];
  }
  if (record.type === "integer" || record.type === "number") {
    if (Array.isArray(record.enum) && typeof record.enum[0] === "number") return record.enum[0];
    return 1;
  }
  if (record.type === "boolean") return true;
  if (record.type === "string") {
    if (record.format === "date-time") return "2026-01-01T00:00:00.000Z";
    if (record.format === "email" || String(record.format ?? "").includes("email")) {
      return "user@example.com";
    }
    if (Array.isArray(record.enum) && typeof record.enum[0] === "string") return record.enum[0];
    return "sample";
  }
  if (record.type === "object" || record.properties) {
    const properties = /** @type {Record<string, unknown>} */ (record.properties ?? {});
    const required = Array.isArray(record.required) ? record.required.map(String) : [];
    const keys = required.length > 0 ? required : Object.keys(properties).slice(0, 6);
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const key of keys.slice(0, 16)) {
      out[key] = sampleFromSchema(spec, properties[key], depth + 1);
    }
    return out;
  }
  return {};
}

/**
 * @param {object} spec
 * @param {unknown} schema
 */
function bodyFieldsFrom(spec, schema) {
  const node = resolveSchema(spec, schema, 0, new Set());
  if (!node || typeof node !== "object") return [];
  const record = /** @type {Record<string, unknown>} */ (node);
  const properties = /** @type {Record<string, unknown>} */ (record.properties ?? {});
  const required = new Set(Array.isArray(record.required) ? record.required.map(String) : []);
  return Object.keys(properties)
    .slice(0, 40)
    .map((name) => ({
      name,
      type: typeLabel(resolveSchema(spec, properties[name], 0, new Set())),
      required: required.has(name),
    }));
}

/**
 * @param {string} name
 */
function sampleForParam(name) {
  const lower = name.toLowerCase();
  if (lower.includes("email")) return "user@example.com";
  if (lower.includes("password")) return "sample-password-value";
  if (lower.endsWith("id") || lower === "id") return "1";
  if (lower.includes("page")) return "1";
  return "sample";
}

/**
 * @param {object} spec
 */
export function planOperations(spec) {
  for (const path of READ_POST_PATHS) {
    const op = spec.paths?.[path]?.post;
    if (!op) throw new Error(`READ_POST path is not a POST in the spec: ${path}`);
    if (READ_POST_FORBIDDEN.test(path)) {
      throw new Error(`READ_POST path contains a mutation word: ${path}`);
    }
  }
  for (const path of GET_SIDE_EFFECT_PATHS) {
    if (!spec.paths?.[path]?.get) throw new Error(`GET side-effect path missing: ${path}`);
  }

  /** @type {object[]} */
  const rows = [];
  /** @type {{ method: string, path: string, tag: string, reason: string }[]} */
  const exclusions = [];
  const seen = new Map();

  for (const [path, item] of Object.entries(spec.paths ?? {})) {
    for (const method of METHODS) {
      const op = item[method];
      if (!op) continue;
      const tag = (op.tags && op.tags[0]) || "Untagged";
      const reason = exclusionReason(method.toUpperCase(), path, tag, op);
      if (reason !== null) {
        exclusions.push({ method: method.toUpperCase(), path, tag, reason });
        continue;
      }
      const toolset = toolsetForTag(tag);
      const summary = String(op.summary || op.description || `${method.toUpperCase()} ${path}`)
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 240);
      let action = actionFrom(method.toUpperCase(), path, tag);
      const key = `${toolset}::${action}`;
      if (seen.has(key)) {
        const params = [...path.matchAll(/\{([^}]+)\}/g)].map((match) => slug(match[1] ?? ""));
        const withParams =
          params.length > 0 ? `${action}_${params.join("_")}` : `${action}_${method}`;
        action = seen.has(`${toolset}::${withParams}`)
          ? `${withParams}_${rows.length}`
          : withParams;
      }
      seen.set(`${toolset}::${action}`, `${method} ${path}`);

      const allParams = [...(item.parameters || []), ...(op.parameters || [])];
      /** @type {string[]} */
      const pathParams = [];
      /** @type {string[]} */
      const queryParams = [];
      /** @type {string[]} */
      const headerParams = [];
      /** @type {Record<string, string>} */
      const sampleParams = {};
      /** @type {Record<string, string>} */
      const sampleQuery = {};
      /** @type {{ name: string, type: string, required: boolean, in: string }[]} */
      const fields = [];
      for (const param of allParams) {
        if (!param || typeof param !== "object" || param.$ref) continue;
        const name = String(param.name ?? "");
        if (name.length === 0) continue;
        const where = String(param.in ?? "");
        const required = param.required === true || where === "path";
        const type = typeLabel(param.schema ?? { type: "string" });
        if (where === "path") {
          pathParams.push(name);
          sampleParams[name] = sampleForParam(name);
          fields.push({ name, type, required: true, in: "path" });
        } else if (where === "query") {
          queryParams.push(name);
          if (required) sampleQuery[name] = sampleForParam(name);
          fields.push({ name, type, required, in: "query" });
        } else if (where === "header" && name.toLowerCase() !== "accept") {
          headerParams.push(name);
          sampleParams[name] = sampleForParam(name);
          fields.push({ name, type, required, in: "header" });
        }
      }
      for (const match of path.matchAll(/\{([^}]+)\}/g)) {
        const name = match[1];
        if (name !== undefined && !pathParams.includes(name)) {
          pathParams.push(name);
          sampleParams[name] = sampleForParam(name);
          fields.push({ name, type: "string", required: true, in: "path" });
        }
      }

      const httpMethod = method.toUpperCase();
      const write = classifyWrite(httpMethod, path);
      const warnings = warningsFor(httpMethod, path, summary, write);
      const jsonSchema = op.requestBody?.content?.["application/json"]?.schema;
      const bodyFields = jsonSchema ? bodyFieldsFrom(spec, jsonSchema) : [];
      const sampleBody = jsonSchema ? sampleFromSchema(spec, jsonSchema) : undefined;
      const responseTypes = Object.keys(responseContent(op));
      const kind = responseTypes.length === 0 && httpMethod !== "GET" ? "empty" : "json";

      rows.push({
        method: httpMethod,
        path,
        operationId: `${httpMethod} ${path}`,
        action,
        tool: `komga_${toolset}`,
        toolset,
        tag,
        write,
        destructive: isDestructive(httpMethod, path, warnings),
        revealSecret: httpMethod === "POST" && path === "/api/v2/users/me/api-keys",
        kind,
        summary,
        pathParams,
        queryParams,
        headerParams,
        fields,
        bodyFields,
        warnings,
        sampleParams,
        sampleQuery,
        sampleBody,
      });
    }
  }

  rows.sort((a, b) => {
    const tool = a.tool.localeCompare(b.tool);
    if (tool !== 0) return tool;
    return a.action.localeCompare(b.action);
  });
  exclusions.sort((a, b) => `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`));

  const toolsets = [...new Set(rows.map((row) => row.toolset))].sort();
  /** @type {Record<string, { operations: number, tags: string[] }>} */
  const counts = {};
  for (const toolset of toolsets) {
    const subset = rows.filter((row) => row.toolset === toolset);
    counts[toolset] = {
      operations: subset.length,
      tags: [...new Set(subset.map((row) => row.tag))].sort(),
    };
  }
  for (const name of DEFAULT_TOOLSETS) {
    if (!toolsets.includes(name)) throw new Error(`Default toolset has no operations: ${name}`);
  }
  return { rows, exclusions, counts, toolsets };
}

/**
 * @param {unknown} value
 */
function ts(value) {
  return JSON.stringify(value);
}

/**
 * @param {object} row
 */
function emitRow(row) {
  const options = [
    `action: ${ts(row.action)}`,
    `toolset: ${ts(row.toolset)}`,
    `tag: ${ts(row.tag)}`,
    `operationId: ${ts(row.operationId)}`,
    `write: ${row.write}`,
    `destructive: ${row.destructive}`,
    `revealSecret: ${row.revealSecret}`,
    `kind: ${ts(row.kind)}`,
    `summary: ${ts(row.summary)}`,
    `pathParams: ${ts(row.pathParams)}`,
    `queryParams: ${ts(row.queryParams)}`,
    `headerParams: ${ts(row.headerParams)}`,
    `fields: ${ts(row.fields)}`,
    `bodyFields: ${ts(row.bodyFields)}`,
    `warnings: ${ts(row.warnings)}`,
    `sampleParams: ${ts(row.sampleParams)}`,
    `sampleQuery: ${ts(row.sampleQuery)}`,
  ];
  if (row.sampleBody !== undefined) options.push(`sampleBody: ${ts(row.sampleBody)}`);
  return `  row(${ts(row.method)}, ${ts(row.path)}, ${ts(row.tool)}, {\n    ${options.join(",\n    ")},\n  })`;
}

function emitFile(plan) {
  const header = `/** Generated by scripts/gen-operations.mjs from komga.openapi.json (Komga 1.29.2, MIT). Do not edit by hand. */

import { ConnectorError } from "./errors.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
export type ResponseKind = "json" | "empty";

export interface FieldSchema {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly in?: "path" | "query" | "header";
}

export interface Operation {
  readonly method: HttpMethod;
  readonly path: string;
  readonly tool: string;
  readonly action: string;
  readonly toolset: string;
  readonly tag: string;
  readonly operationId: string;
  readonly write: boolean;
  readonly destructive: boolean;
  readonly revealSecret: boolean;
  readonly kind: ResponseKind;
  readonly summary: string;
  readonly pathParams: readonly string[];
  readonly queryParams: readonly string[];
  readonly headerParams: readonly string[];
  readonly fields: readonly FieldSchema[];
  readonly bodyFields: readonly FieldSchema[];
  readonly warnings: readonly string[];
  readonly sampleParams: Readonly<Record<string, string>>;
  readonly sampleQuery: Readonly<Record<string, string>>;
  readonly sampleBody?: unknown;
}

export interface ExcludedOperation {
  readonly method: HttpMethod;
  readonly path: string;
  readonly tag: string;
  readonly reason: string;
}

function row(
  method: HttpMethod,
  path: string,
  tool: string,
  options: {
    action: string;
    toolset: string;
    tag: string;
    operationId: string;
    write: boolean;
    destructive: boolean;
    revealSecret: boolean;
    kind: ResponseKind;
    summary: string;
    pathParams: readonly string[];
    queryParams: readonly string[];
    headerParams: readonly string[];
    fields: readonly FieldSchema[];
    bodyFields: readonly FieldSchema[];
    warnings: readonly string[];
    sampleParams: Readonly<Record<string, string>>;
    sampleQuery: Readonly<Record<string, string>>;
    sampleBody?: unknown;
  },
): Operation {
  return {
    method,
    path,
    tool,
    action: options.action,
    toolset: options.toolset,
    tag: options.tag,
    operationId: options.operationId,
    write: options.write,
    destructive: options.destructive,
    revealSecret: options.revealSecret,
    kind: options.kind,
    summary: options.summary,
    pathParams: options.pathParams,
    queryParams: options.queryParams,
    headerParams: options.headerParams,
    fields: options.fields,
    bodyFields: options.bodyFields,
    warnings: options.warnings,
    sampleParams: options.sampleParams,
    sampleQuery: options.sampleQuery,
    ...(options.sampleBody !== undefined ? { sampleBody: options.sampleBody } : {}),
  };
}

export const DEFAULT_TOOLSETS = ${ts(DEFAULT_TOOLSETS)} as const;

export const ALL_TOOLSETS = ${ts(plan.toolsets)} as const;

export const READ_POST_PATHS = ${ts(READ_POST_PATHS)} as const;

export const GET_SIDE_EFFECT_PATHS = ${ts(GET_SIDE_EFFECT_PATHS)} as const;

export const TOOLSET_COUNTS: Readonly<
  Record<string, { readonly operations: number; readonly tags: readonly string[] }>
> = ${ts(plan.counts)};

export const EXCLUSIONS: readonly ExcludedOperation[] = ${ts(plan.exclusions)};

export const OPERATIONS: readonly Operation[] = [
${plan.rows.map(emitRow).join(",\n")},
];

export function toolNames(): string[] {
  return [...new Set(OPERATIONS.map((operation) => operation.tool))].sort();
}

export function operationsForTool(name: string): Operation[] {
  return OPERATIONS.filter((operation) => operation.tool === name);
}

export function toolIsWrite(name: string): boolean {
  return OPERATIONS.some((operation) => operation.tool === name && operation.write);
}

export function openApiKeys(): string[] {
  return OPERATIONS.map((operation) => \`\${operation.method} \${operation.path}\`).sort();
}

export function requireOp(tool: string, action: string): Operation {
  const found = OPERATIONS.find((operation) => operation.tool === tool && operation.action === action);
  if (found === undefined) {
    throw new ConnectorError("input", \`Unknown Komga operation \${tool} \${action}.\`);
  }
  return found;
}

export function parseToolsets(raw: string | undefined): readonly string[] {
  if (raw === undefined || raw.trim() === "") return [...DEFAULT_TOOLSETS];
  const trimmed = raw.trim();
  if (trimmed === "all") return [...ALL_TOOLSETS];
  const wanted = trimmed
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const allowed = new Set<string>(ALL_TOOLSETS);
  const unknown = wanted.filter((name) => !allowed.has(name));
  if (unknown.length > 0) {
    throw new ConnectorError("config", "Unknown KOMGA_TOOLSETS value.");
  }
  return [...new Set(wanted)];
}

export function toolsForToolsets(enabled: readonly string[]): string[] {
  const allow = new Set(enabled);
  return toolNames().filter((name) => {
    const operation = OPERATIONS.find((row) => row.tool === name);
    return operation !== undefined && allow.has(operation.toolset);
  });
}
`;
  return header;
}

function main() {
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  const plan = planOperations(spec);
  const file = emitFile(plan);
  writeFileSync(join(root, "src/operations.ts"), file);
  const writes = plan.rows.filter((row) => row.write).length;
  const reads = plan.rows.length - writes;
  console.log(
    `operations ${plan.rows.length} excluded ${plan.exclusions.length} tools ${plan.toolsets.length} reads ${reads} writes ${writes}`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
