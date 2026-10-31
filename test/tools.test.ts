import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toolDescription, toolName, type ToolDescription } from "../src/brand.js";
import { ConnectorError } from "../src/errors.js";
import { createLogger } from "../src/log.js";
import { assertToolSpec, READ_ONLY_REMOTE, registerConnectorTool } from "../src/tools.js";

const ctx = { secrets: [] as const, logger: createLogger([]) };

describe("tool registration", () => {
  it("rejects a blank description at the boundary", () => {
    expect(() => toolDescription("   ")).toThrow(ConnectorError);
    expect(() => toolName("Bad-Name")).toThrow(ConnectorError);
  });

  it("rejects an empty description and a non-object schema at runtime", () => {
    expect(() => {
      assertToolSpec({ name: "example_lookup", description: "  ", inputSchema: z.object({}) });
    }).toThrow(/non-empty description/);
    expect(() => {
      assertToolSpec({
        name: "example_lookup",
        description: "Look up a record.",
        inputSchema: z.string(),
      });
    }).toThrow(/Zod object schema/);
  });

  it("rejects a branded empty description before the tool is published", () => {
    const server = new McpServer({ name: "t", version: "0" });
    expect(() => {
      registerConnectorTool(
        server,
        {
          name: toolName("example_lookup"),
          description: "   " as ToolDescription,
          inputSchema: z.object({}),
          annotations: READ_ONLY_REMOTE,
          handler: () => Promise.resolve({}),
        },
        ctx,
      );
    }).toThrow(/non-empty description/);
  });
});
