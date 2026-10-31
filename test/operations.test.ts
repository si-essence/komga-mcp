import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALL_TOOLSETS,
  DEFAULT_TOOLSETS,
  EXCLUSIONS,
  GET_SIDE_EFFECT_PATHS,
  OPERATIONS,
  READ_POST_PATHS,
  parseToolsets,
  toolNames,
} from "../src/operations.js";

function planned(): { actions: string[]; exclusions: string[] } {
  const script = [
    'import { planOperations } from "./scripts/gen-operations.mjs";',
    'import { readFileSync } from "node:fs";',
    'const spec = JSON.parse(readFileSync("./komga.openapi.json", "utf8"));',
    "const plan = planOperations(spec);",
    "process.stdout.write(JSON.stringify({",
    '  actions: plan.rows.map((row) => row.tool + ":" + row.action),',
    '  exclusions: plan.exclusions.map((row) => row.method + " " + row.path),',
    "}));",
  ].join("\n");
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("..", import.meta.url)),
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || "generator failed");
  }
  return JSON.parse(result.stdout) as { actions: string[]; exclusions: string[] };
}

const METHODS = ["get", "post", "put", "patch", "delete"] as const;
const MUTATION = /delete|remove|update|create|scan|analyze|refresh|clear|reset|login|register/i;

function loadSpec(): { paths: Record<string, Record<string, unknown>> } {
  return JSON.parse(readFileSync(new URL("../komga.openapi.json", import.meta.url), "utf8")) as {
    paths: Record<string, Record<string, unknown>>;
  };
}

function specKeys(spec: { paths: Record<string, Record<string, unknown>> }): string[] {
  const keys: string[] = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const method of METHODS) {
      if (item[method] !== undefined) keys.push(`${method.toUpperCase()} ${path}`);
    }
  }
  return keys.sort();
}

describe("OpenAPI coverage", () => {
  const spec = loadSpec();
  const specSet = new Set(specKeys(spec));
  const registry = OPERATIONS.map((operation) => `${operation.method} ${operation.path}`);
  const excluded = EXCLUSIONS.map((operation) => `${operation.method} ${operation.path}`);

  it("matches the spec in both directions, with every exclusion reasoned", () => {
    expect(new Set(registry).size).toBe(registry.length);
    expect(new Set(excluded).size).toBe(excluded.length);
    for (const key of registry) {
      expect(specSet.has(key), key).toBe(true);
      expect(excluded).not.toContain(key);
    }
    for (const key of excluded) {
      expect(specSet.has(key), key).toBe(true);
    }
    for (const key of specSet) {
      const covered = registry.includes(key);
      const skipped = excluded.includes(key);
      expect(covered !== skipped, key).toBe(true);
    }
    expect(registry.length + excluded.length).toBe(specSet.size);
    expect(registry.length).toBe(155);
    expect(excluded.length).toBe(22);
    for (const row of EXCLUSIONS) {
      expect(row.reason.trim().length).toBeGreaterThan(20);
    }
  });

  it("keeps action names unique and stable against the generator", () => {
    const seen = new Set<string>();
    for (const operation of OPERATIONS) {
      const id = `${operation.tool}:${operation.action}`;
      expect(seen.has(id), id).toBe(false);
      seen.add(id);
      expect(operation.action).not.toBe("help");
      expect(operation.action).toMatch(/^[a-z0-9_]+$/);
    }
    const plan = planned();
    expect([...plan.actions].sort()).toEqual(
      OPERATIONS.map((operation) => `${operation.tool}:${operation.action}`).sort(),
    );
    expect([...plan.exclusions].sort()).toEqual([...excluded].sort());
    const library = OPERATIONS.find(
      (operation) => operation.method === "GET" && operation.path === "/api/v1/libraries",
    );
    expect(library?.action).toBe("get");
    const series = OPERATIONS.find(
      (operation) => operation.method === "POST" && operation.path === "/api/v1/series/list",
    );
    expect(series?.action).toBe("post_list");
    expect(series?.write).toBe(false);
  });

  it("allow-lists only real POST reads and marks side-effect GETs as writes", () => {
    for (const path of READ_POST_PATHS) {
      expect(spec.paths[path]?.["post"], path).toBeDefined();
      expect(path).not.toMatch(MUTATION);
      const operation = OPERATIONS.find((row) => row.method === "POST" && row.path === path);
      expect(operation?.write, path).toBe(false);
    }
    for (const operation of OPERATIONS) {
      if (operation.method === "POST" && !operation.write) {
        expect(READ_POST_PATHS).toContain(operation.path);
      }
      if (operation.method === "GET" && operation.write) {
        expect(GET_SIDE_EFFECT_PATHS).toContain(operation.path);
      }
    }
    for (const path of GET_SIDE_EFFECT_PATHS) {
      expect(spec.paths[path]?.["get"], path).toBeDefined();
    }
  });
});

describe("toolset scoping", () => {
  it("defaults to the read-focused subset and treats all as every toolset", () => {
    expect([...parseToolsets(undefined)]).toEqual([...DEFAULT_TOOLSETS]);
    expect([...parseToolsets("all")]).toEqual([...ALL_TOOLSETS]);
    expect(parseToolsets("libraries,series")).toEqual(["libraries", "series"]);
    expect(toolNames()).toHaveLength(ALL_TOOLSETS.length);
    expect(DEFAULT_TOOLSETS).toEqual([
      "libraries",
      "series",
      "books",
      "collections",
      "readlists",
      "referential_metadata",
      "management",
    ]);
  });
});
