#!/usr/bin/env node
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { CONNECTOR_NAME } from "./constants.js";
import { loadConfig } from "./config.js";
import { ConnectorError } from "./errors.js";
import { createLogger } from "./log.js";
import { createRuntime, type Runtime } from "./runtime.js";
import { createServer } from "./server.js";

const MAX_HTTP_BODY = 1_000_000;

function failStartup(error: unknown): never {
  const logger = createLogger([]);
  logger.error(error instanceof ConnectorError ? error.message : "Startup failed.");
  process.exit(1);
}

let runtime: Runtime;
try {
  runtime = createRuntime(loadConfig(process.env, process.argv));
} catch (error) {
  failStartup(error);
}

if (runtime.config.transport === "http") {
  const http = createHttpServer((req, res) => {
    void handleHttp(runtime, req, res);
  });
  http.on("error", (error: Error) => {
    runtime.logger.error(error.message);
  });
  http.listen(runtime.config.port, () => {
    runtime.logger.info(`${CONNECTOR_NAME} HTTP on :${runtime.config.port}/mcp`);
  });
} else {
  await createServer(runtime).connect(new StdioServerTransport());
}

async function handleHttp(
  active: Runtime,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const path = pathOnly(req.url);
    if (path === "/health") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("ok");
      return;
    }
    if (path !== "/mcp") {
      res.writeHead(404);
      res.end();
      return;
    }
    const raw = await readRequestBody(req);
    const body = raw.trim().length === 0 ? undefined : parseRequestJson(raw);
    const mcp = createServer(active);
    // Omitting sessionIdGenerator selects stateless Streamable HTTP.
    const transport = new StreamableHTTPServerTransport();
    res.on("close", () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(asTransport(transport));
    await transport.handleRequest(req, res, body);
  } catch (error) {
    active.logger.error(error instanceof ConnectorError ? error.message : "request failed");
    if (res.headersSent) return;
    const tooLarge = error instanceof ConnectorError && error.message.includes("too large");
    res.writeHead(tooLarge ? 413 : 400, { "content-type": "text/plain; charset=utf-8" });
    res.end(tooLarge ? "payload too large" : "bad request");
  }
}

function asTransport(transport: StreamableHTTPServerTransport): Transport {
  // The SDK types onclose as `(() => void) | undefined`. exactOptionalPropertyTypes
  // rejects that for Transport's optional onclose. The instance is still a Transport.
  return transport as Transport;
}

function pathOnly(url: string | undefined): string {
  if (url === undefined || url.length === 0) return "/";
  const query = url.indexOf("?");
  const path = query === -1 ? url : url.slice(0, query);
  if (path.length > 1 && path.endsWith("/")) return path.slice(0, -1);
  return path.length === 0 ? "/" : path;
}

async function readRequestBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  const stream: AsyncIterable<unknown> = req;
  for await (const chunk of stream) {
    const buffer = toBuffer(chunk);
    size += buffer.length;
    if (size > MAX_HTTP_BODY) {
      throw new ConnectorError("input", "Request body was too large.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function toBuffer(chunk: unknown): Buffer {
  if (typeof chunk === "string") return Buffer.from(chunk);
  if (chunk instanceof Uint8Array) return Buffer.from(chunk);
  throw new ConnectorError("input", "Request body was not valid.");
}

function parseRequestJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new ConnectorError("input", "Request body was not valid JSON.");
  }
}
