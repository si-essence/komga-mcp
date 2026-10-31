import { ConnectorError } from "./errors.js";
import type { QueryMap, QueryValue } from "./http.js";
import { definedQuery, fillOpenApiPath, jsonValueSchema } from "./json.js";
import type { Operation } from "./operations.js";
import { asJsonObject } from "./parse.js";
import type { Runtime } from "./runtime.js";
import { withWrite } from "./write-gate.js";

export interface CallArgs {
  readonly params?:
    | Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>>
    | undefined;
  readonly query?:
    | Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>>
    | undefined;
  readonly body?: unknown;
  readonly confirm?: true | undefined;
}

function asQuery(
  record:
    | Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>>
    | undefined,
): QueryMap | undefined {
  if (record === undefined) return undefined;
  const mapped: Record<string, QueryValue> = {};
  for (const [key, value] of Object.entries(record)) mapped[key] = value;
  return definedQuery(mapped);
}

function asParams(
  record:
    | Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>>
    | undefined,
): Record<string, string | number> {
  if (record === undefined) return {};
  const out: Record<string, string | number> = {};
  for (const [key, value] of Object.entries(record)) {
    if (typeof value === "boolean") out[key] = String(value);
    else if (typeof value === "string" || typeof value === "number") out[key] = value;
    else {
      throw new ConnectorError("input", `Path parameter ${key} must be a string or a number.`);
    }
  }
  return out;
}

function rememberRevealed(runtime: Runtime, value: unknown): void {
  if (Array.isArray(value)) {
    for (const item of value) rememberRevealed(runtime, item);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (key === "key" && typeof entry === "string" && entry.length >= 8) {
      runtime.client.rememberSecret(entry);
      continue;
    }
    rememberRevealed(runtime, entry);
  }
}

function extraHeaders(
  operation: Operation,
  record:
    | Readonly<Record<string, string | number | boolean | readonly (string | number | boolean)[]>>
    | undefined,
): Record<string, string> | undefined {
  if (operation.headerParams.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const name of operation.headerParams) {
    const value = record?.[name];
    if (value === undefined) {
      throw new ConnectorError("input", `Missing header parameter ${name}.`);
    }
    if (typeof value === "boolean" || typeof value === "number") out[name] = String(value);
    else if (typeof value === "string") out[name] = value;
    else {
      throw new ConnectorError("input", `Header parameter ${name} must be a string or a number.`);
    }
  }
  return out;
}

export async function callKomga(
  runtime: Runtime,
  operation: Operation,
  args: CallArgs = {},
): Promise<Record<string, unknown>> {
  const path = fillOpenApiPath(operation.path, asParams(args.params));
  const query = asQuery(args.query);
  const ttlSec = operation.write ? 0 : runtime.cacheTtlSec;

  const run = async (): Promise<Record<string, unknown>> => {
    const headers = extraHeaders(operation, args.params);
    const result = await execute(runtime, operation, path, query, args, ttlSec, headers);
    if (operation.revealSecret) rememberRevealed(runtime, result);
    return result;
  };

  if (!operation.write) return run();

  return withWrite(
    runtime,
    args.confirm,
    {
      method: operation.method,
      path,
      query,
      body: args.body,
      summary: operation.summary,
      warnings: operation.warnings,
      revealSecret: operation.revealSecret,
    },
    run,
  );
}

function withExtra<T extends object>(
  base: T,
  extra: Record<string, string> | undefined,
): T | (T & { extraHeaders: Record<string, string> }) {
  if (extra === undefined) return base;
  return { ...base, extraHeaders: extra };
}

async function execute(
  runtime: Runtime,
  operation: Operation,
  path: string,
  query: QueryMap | undefined,
  args: CallArgs,
  ttlSec: number,
  extra: Record<string, string> | undefined,
): Promise<Record<string, unknown>> {
  const fieldRedact = !operation.revealSecret;
  if (operation.kind === "empty") {
    if (operation.method === "POST") {
      if (args.body === undefined) {
        const sent = await runtime.client.postEmpty(withExtra({ path, query, fieldRedact }, extra));
        return unwrap(sent.body);
      }
      const json = await runtime.client.postJson(
        withExtra({ path, query, body: args.body, fieldRedact }, extra),
        jsonValueSchema,
      );
      return unwrap(json);
    }
    if (operation.method === "PUT") {
      if (args.body === undefined) {
        const sent = await runtime.client.putEmpty(withExtra({ path, query, fieldRedact }, extra));
        return unwrap(sent.body);
      }
      const json = await runtime.client.putJson(
        withExtra({ path, query, body: args.body, fieldRedact }, extra),
        jsonValueSchema,
      );
      return unwrap(json);
    }
    if (operation.method === "PATCH") {
      if (args.body === undefined) {
        const sent = await runtime.client.patchEmpty(withExtra({ path, query, fieldRedact }, extra));
        return unwrap(sent.body);
      }
      const json = await runtime.client.patchJson(
        withExtra({ path, query, body: args.body, fieldRedact }, extra),
        jsonValueSchema,
      );
      return unwrap(json);
    }
    if (args.body === undefined) {
      const sent = await runtime.client.delete(withExtra({ path, query, fieldRedact }, extra));
      return unwrap(sent.body);
    }
    const json = await runtime.client.deleteJson(
      withExtra({ path, query, body: args.body, fieldRedact }, extra),
      jsonValueSchema,
    );
    return unwrap(json);
  }

  if (operation.method === "GET") {
    const json = await runtime.client.getJson(
      withExtra({ path, query, ttlSec, fieldRedact }, extra),
      jsonValueSchema,
    );
    return unwrap(json);
  }
  if (operation.method === "POST") {
    const json = await runtime.client.postJson(
      withExtra({ path, query, body: args.body ?? {}, fieldRedact }, extra),
      jsonValueSchema,
    );
    return unwrap(json);
  }
  if (operation.method === "PUT") {
    const json = await runtime.client.putJson(
      withExtra({ path, query, body: args.body ?? {}, fieldRedact }, extra),
      jsonValueSchema,
    );
    return unwrap(json);
  }
  if (operation.method === "PATCH") {
    const json = await runtime.client.patchJson(
      withExtra({ path, query, body: args.body ?? {}, fieldRedact }, extra),
      jsonValueSchema,
    );
    return unwrap(json);
  }
  const json = await runtime.client.deleteJson(
    withExtra({ path, query, body: args.body ?? {}, fieldRedact }, extra),
    jsonValueSchema,
  );
  return unwrap(json);
}

function unwrap(json: unknown): Record<string, unknown> {
  return asJsonObject(json);
}
