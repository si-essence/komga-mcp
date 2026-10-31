#!/usr/bin/env node
/**
 * Live check against a real Komga server. Claims a fresh instance when needed,
 * writes a tiny CBZ under /workspace/tools/komga-lib, then spawns dist/index.js
 * over stdio. Prints pass/fail lines only. Never prints secrets.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

delete process.env["DATABASE_URL"];

const root = fileURLToPath(new URL("..", import.meta.url));
const baseUrl = (process.env["KOMGA_URL"] ?? "http://127.0.0.1:25600").replace(/\/+$/, "");
const libDir = "/workspace/tools/komga-lib";
const email = "admin@example.com";

const writeLine = console.log.bind(console);

/** @type {string[]} */
const secrets = [];

/**
 * @param {string} text
 */
function redact(text) {
  let out = String(text);
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    out = out.split(secret).join("[redacted]");
    out = out.split(encodeURIComponent(secret)).join("[redacted]");
  }
  out = out.replace(/(authorization:\s*basic\s+)\S+/gi, "Authorization: Basic [redacted]");
  out = out.replace(/(x-api-key:\s*)\S+/gi, "$1[redacted]");
  out = out.replace(
    /"(apiKey|key|secret|token|refreshToken|refresh_token|password|email|client_secret|access_token)"\s*:\s*"[^"]*"/gi,
    '"$1":"[redacted]"',
  );
  return out;
}

console.log = (line) => writeLine(redact(String(line)));
console.error = (line) => writeLine(redact(String(line)));

let failed = 0;
let passed = 0;

/**
 * @param {string} name
 * @param {boolean} ok
 */
function record(name, ok) {
  if (ok) passed += 1;
  else failed += 1;
  writeLine(`${ok ? "PASS" : "FAIL"}  ${name}`);
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @param {string} key
 * @returns {string | undefined}
 */
function firstString(value, key) {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = firstString(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  const entry = value[key];
  if (typeof entry === "string" && entry.length > 0 && entry !== "[redacted]") return entry;
  if (typeof entry === "number" && Number.isFinite(entry)) return String(entry);
  for (const nested of Object.values(value)) {
    const found = firstString(nested, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * @param {string} method
 * @param {string} path
 * @param {Record<string, string>} headers
 * @param {unknown} [body]
 */
async function raw(method, path, headers, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  for (const secret of secrets) {
    if (secret.length >= 8 && text.includes(secret)) {
      throw new Error("secret leaked into raw response");
    }
  }
  /** @type {unknown} */
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = text.length === 0 ? {} : { text };
  }
  return { status: response.status, json, text };
}

function basicHeader(password) {
  return `Basic ${Buffer.from(`${email}:${password}`, "utf8").toString("base64")}`;
}

function writeTinyCbz() {
  mkdirSync(join(libDir, "Series1"), { recursive: true });
  const py = `
import pathlib, struct, zlib, zipfile
root = pathlib.Path(${JSON.stringify(join(libDir, "Series1"))})
root.mkdir(parents=True, exist_ok=True)

def png(path, r, g, b):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xffffffff)
    raw = bytes([0, r, g, b])
    ihdr = struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)
    path.write_bytes(b"\\x89PNG\\r\\n\\x1a\\n" + chunk(b"IHDR", ihdr) + chunk(b"IDAT", zlib.compress(raw)) + chunk(b"IEND", b""))

pages = root / "_pages"
pages.mkdir(exist_ok=True)
png(pages / "1.png", 200, 30, 30)
png(pages / "2.png", 30, 200, 30)
png(pages / "3.png", 30, 30, 200)
cbz = root / "issue-1.cbz"
with zipfile.ZipFile(cbz, "w") as zf:
    for name in ("1.png", "2.png", "3.png"):
        zf.write(pages / name, name)
`;
  const result = spawnSync("python3", ["-c", py], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(redact(result.stderr || "cbz write failed"));
  }
}

const libraryBody = {
  name: "mcp-live",
  root: libDir,
  importComicInfoBook: true,
  importComicInfoSeries: true,
  importComicInfoCollection: true,
  importComicInfoReadList: true,
  importComicInfoSeriesAppendVolume: false,
  importEpubBook: true,
  importEpubSeries: true,
  importLocalArtwork: true,
  importBarcodeIsbn: false,
  importMylarSeries: false,
  repairExtensions: false,
  convertToCbz: false,
  emptyTrashAfterScan: false,
  hashFiles: false,
  hashPages: false,
  hashKoreader: false,
  analyzeDimensions: false,
  scanCbx: true,
  scanEpub: true,
  scanPdf: true,
  scanForceModifiedTime: false,
  scanOnStartup: false,
  scanInterval: "DISABLED",
  seriesCover: "FIRST",
  scanDirectoryExclusions: [],
};

/**
 * @param {import("@modelcontextprotocol/sdk/client/index.js").Client} client
 * @param {string} name
 * @param {Record<string, unknown>} args
 */
async function call(client, name, args) {
  const result = await client.callTool({ name, arguments: args });
  const block = Array.isArray(result.content) ? result.content[0] : undefined;
  const text = block && typeof block === "object" && "text" in block ? String(block.text) : "";
  for (const secret of secrets) {
    if (secret.length >= 8 && text.includes(secret)) {
      throw new Error("secret leaked into tool output");
    }
  }
  /** @type {Record<string, unknown> | null} */
  let json = null;
  try {
    const parsed = JSON.parse(text);
    json = isRecord(parsed) ? parsed : { value: parsed };
  } catch {
    json = null;
  }
  return { isError: result.isError === true, text, json };
}

/**
 * @param {{ isError: boolean, text: string }} result
 */
function cleanMiss(result) {
  if (!result.isError) return false;
  if (/Server\.js|\.js:\d|stack trace|\/tmp\/|\/var\//i.test(result.text)) return false;
  return result.text.includes("[not-found]") || /not found|does not exist/i.test(result.text);
}

/**
 * @param {import("@modelcontextprotocol/sdk/client/index.js").Client} client
 * @param {string} name
 * @param {string} tool
 * @param {Record<string, unknown>} args
 */
async function readOk(client, name, tool, args) {
  const result = await call(client, tool, args);
  const leaked = secrets.some((secret) => secret.length >= 8 && result.text.includes(secret));
  record(name, !result.isError && !leaked && !/stack trace|\.kt:\d/i.test(result.text));
  return result;
}

async function prepare() {
  writeTinyCbz();
  const status = await raw("GET", "/api/v1/claim", { accept: "application/json" });
  const claimed =
    isRecord(status.json) && status.json["isClaimed"] === true ? true : status.status === 200
      ? false
      : undefined;
  let password = process.env["KOMGA_PASSWORD"] ?? "";
  if (claimed !== true) {
    if (password.length < 8) {
      password = randomBytes(18).toString("base64url");
    }
    secrets.push(password);
    const claimedRes = await raw(
      "POST",
      "/api/v1/claim",
      {
        accept: "application/json",
        "X-Komga-Email": email,
        "X-Komga-Password": password,
      },
    );
    record("claim server", claimedRes.status === 200);
    if (claimedRes.status !== 200) {
      throw new Error(`claim failed HTTP ${claimedRes.status}`);
    }
  } else {
    secrets.push(password);
    record("claim already done", password.length >= 8);
    if (password.length < 8) {
      throw new Error("server already claimed and KOMGA_PASSWORD is unset");
    }
  }
  const auth = { accept: "application/json", authorization: basicHeader(password) };
  const listed = await raw("GET", "/api/v1/libraries", auth);
  let libraryId = firstString(listed.json, "id");
  if (libraryId === undefined) {
    const created = await raw("POST", "/api/v1/libraries", { ...auth, "content-type": "application/json" }, libraryBody);
    libraryId = firstString(created.json, "id");
    record("create library", created.status === 200 && libraryId !== undefined);
  } else {
    record("library exists", true);
  }
  if (libraryId !== undefined) {
    const scanned = await raw("POST", `/api/v1/libraries/${libraryId}/scan?deep=true`, auth);
    record("scan library", scanned.status === 202 || scanned.status === 200);
    for (let i = 0; i < 20; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      const books = await raw("GET", "/api/v1/series", auth);
      const id = firstString(books.json, "id");
      if (id !== undefined) break;
    }
  }
  return password;
}

async function main() {
  if (baseUrl.length === 0) {
    writeLine("SKIP  live-check  KOMGA_URL is unset.");
    return;
  }

  const password = await prepare();

  const transport = new StdioClientTransport({
    command: "node",
    args: ["dist/index.js"],
    cwd: root,
    env: {
      ...process.env,
      DATABASE_URL: "",
      KOMGA_URL: baseUrl,
      KOMGA_USERNAME: email,
      KOMGA_PASSWORD: password,
      KOMGA_ALLOW_WRITES: "true",
      KOMGA_TOOLSETS: "all",
      KOMGA_CACHE_TTL_SEC: "0",
      KOMGA_PER_MINUTE: "300",
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "komga-live-check", version: "0" });
  await client.connect(transport);

  try {
    const listed = await client.listTools();
    record("lists tools", Array.isArray(listed.tools) && listed.tools.length >= 7);

    await readOk(client, "server info", "komga_management", { action: "get_actuator_info" });
    await readOk(client, "claim status", "komga_claim", { action: "get" });
    const me = await readOk(client, "current user", "komga_current_user", { action: "get_users_me" });
    record(
      "user redacts secrets",
      firstString(me.json, "password") === undefined &&
        firstString(me.json, "email") === undefined &&
        !secrets.some((secret) => secret.length >= 8 && me.text.includes(secret)),
    );
    await readOk(client, "libraries", "komga_libraries", { action: "get" });
    const series = await readOk(client, "series", "komga_series", { action: "get" });
    await readOk(client, "books list", "komga_books", {
      action: "post_list",
      query: { size: "5" },
      body: {},
    });
    await readOk(client, "age ratings", "komga_referential_metadata", { action: "get_age_ratings" });

    const missing = await call(client, "komga_series", {
      action: "get_series_id",
      params: { seriesId: "00000000-0000-0000-0000-000000000000" },
    });
    record("series unknown id", cleanMiss(missing));

    const seriesId = firstString(series.json, "id");
    const preview = await call(client, "komga_libraries", {
      action: "delete",
      params: { libraryId: "00000000-0000-0000-0000-000000000000" },
    });
    record(
      "library delete preview",
      preview.json?.["dry_run"] === true && preview.json?.["executed"] === false,
    );

    if (seriesId !== undefined) {
      const writePreview = await call(client, "komga_series", {
        action: "post_read_progress",
        params: { seriesId },
      });
      record(
        "mark-read preview",
        writePreview.json?.["dry_run"] === true && writePreview.json?.["executed"] === false,
      );
      const marked = await call(client, "komga_series", {
        action: "post_read_progress",
        params: { seriesId },
        confirm: true,
      });
      record("mark series read", !marked.isError && marked.json?.["executed"] === true);
    } else {
      record("mark-read preview", false);
      record("mark series read", false);
    }
  } finally {
    await client.close();
    await transport.close();
  }

  if (failed > 0) {
    writeLine(`FAIL  live-check  passed=${passed} failed=${failed}`);
    process.exit(1);
  }
  writeLine(`PASS  live-check  passed=${passed} failed=0`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : "live-check failed";
  writeLine(`FAIL  live-check  ${redact(message).slice(0, 180)}`);
  process.exit(1);
});
