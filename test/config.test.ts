import { describe, expect, it } from "vitest";
import { CONNECTOR_NAME, CONNECTOR_VERSION } from "../src/constants.js";
import { loadConfig } from "../src/config.js";
import { ConnectorError } from "../src/errors.js";
import { DEFAULT_TOOLSETS } from "../src/operations.js";

const KEY = "super-secret/key+value=99";
const URL = "http://127.0.0.1:5000";

function messageOf(error: unknown): string {
  expect(error).toBeInstanceOf(ConnectorError);
  if (!(error instanceof ConnectorError)) throw error;
  return error.message;
}

function catchError(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe("loadConfig", () => {
  it("requires KOMGA_URL", () => {
    const message = messageOf(catchError(() => loadConfig({}, [])));
    expect(message).toContain("KOMGA_URL");
    expect(message).toContain("required");
  });

  it("applies defaults when the URL is set", () => {
    const config = loadConfig({ KOMGA_URL: URL }, []);
    expect(config.apiKey).toBeUndefined();
    expect(config.username).toBeUndefined();
    expect(config.password).toBeUndefined();
    expect(config.baseUrl).toBe(URL);
    expect(config.allowWrites).toBe(false);
    expect(config.toolsets).toEqual([...DEFAULT_TOOLSETS]);
    expect(config.perMinute).toBe(30);
    expect(config.timeoutMs).toBe(20_000);
    expect(config.contact).toBe("contact@example.com");
    expect(config.transport).toBe("stdio");
    expect(config.port).toBe(3000);
    expect(config.cacheTtlSec).toBe(60);
    expect(config.userAgent).toBe(`${CONNECTOR_NAME}/${CONNECTOR_VERSION} (contact@example.com)`);
  });

  it("lets --http override the transport", () => {
    expect(
      loadConfig({ KOMGA_URL: URL, MCP_TRANSPORT: "stdio" }, ["node", "app", "--http"]).transport,
    ).toBe("http");
    expect(loadConfig({ KOMGA_URL: URL, MCP_TRANSPORT: "http" }, []).transport).toBe("http");
  });

  it("enables writes only when KOMGA_ALLOW_WRITES is the literal true", () => {
    expect(loadConfig({ KOMGA_URL: URL, KOMGA_ALLOW_WRITES: "true" }, []).allowWrites).toBe(true);
    expect(loadConfig({ KOMGA_URL: URL, KOMGA_ALLOW_WRITES: "TRUE" }, []).allowWrites).toBe(false);
    expect(loadConfig({ KOMGA_URL: URL, KOMGA_ALLOW_WRITES: "1" }, []).allowWrites).toBe(false);
  });

  it("parses KOMGA_TOOLSETS", () => {
    expect(loadConfig({ KOMGA_URL: URL, KOMGA_TOOLSETS: "all" }, []).toolsets).toContain("users");
    expect(
      loadConfig({ KOMGA_URL: URL, KOMGA_TOOLSETS: "libraries, series" }, []).toolsets,
    ).toEqual(["libraries", "series"]);
  });

  it("rejects an unknown toolset", () => {
    const message = messageOf(
      catchError(() => loadConfig({ KOMGA_URL: URL, KOMGA_TOOLSETS: "nope" }, [])),
    );
    expect(message).toContain("KOMGA_TOOLSETS");
    expect(message).not.toContain("nope");
  });

  it("accepts a self-hosted origin", () => {
    expect(loadConfig({ KOMGA_URL: "http://127.0.0.1:25600" }, []).baseUrl).toBe(
      "http://127.0.0.1:25600",
    );
  });

  it("reports invalid fields without the rejected value or the api key", () => {
    const message = messageOf(
      catchError(() =>
        loadConfig({ KOMGA_URL: URL, KOMGA_API_KEY: KEY, PORT: "nope", MCP_TRANSPORT: "sse" }, []),
      ),
    );
    expect(message).toContain("PORT");
    expect(message).toContain("MCP_TRANSPORT");
    expect(message).not.toContain(KEY);
    expect(message).not.toContain("nope");
    expect(message).not.toContain("sse");
  });

  it("rejects a short api key without echoing it", () => {
    const message = messageOf(
      catchError(() => loadConfig({ KOMGA_URL: URL, KOMGA_API_KEY: "short" }, [])),
    );
    expect(message).toContain("KOMGA_API_KEY");
    expect(message).not.toContain("short");
  });

  it("rejects a base url or contact that contains the api key", () => {
    const inUrl = messageOf(
      catchError(() =>
        loadConfig({ KOMGA_API_KEY: KEY, KOMGA_URL: `https://komga.test/${KEY}` }, []),
      ),
    );
    expect(inUrl).toContain("contains_secret");
    expect(inUrl).not.toContain(KEY);

    const inContact = messageOf(
      catchError(() => loadConfig({ KOMGA_URL: URL, KOMGA_API_KEY: KEY, KOMGA_CONTACT: KEY }, [])),
    );
    expect(inContact).toContain("KOMGA_CONTACT");
    expect(inContact).not.toContain(KEY);
  });

  it("rejects userinfo and query strings on the base url", () => {
    const userinfo = messageOf(
      catchError(() => loadConfig({ KOMGA_URL: "https://user:pass@komga.test" }, [])),
    );
    expect(userinfo).toContain("userinfo");
    expect(userinfo).not.toContain("pass");

    const query = messageOf(
      catchError(() => loadConfig({ KOMGA_URL: `https://komga.test?api_key=${KEY}` }, [])),
    );
    expect(query).toContain("KOMGA_URL");
    expect(query).not.toContain(KEY);
  });

  it("requires username and password together", () => {
    const message = messageOf(
      catchError(() => loadConfig({ KOMGA_URL: URL, KOMGA_USERNAME: "ada" }, [])),
    );
    expect(message).toContain("KOMGA_PASSWORD");
    const config = loadConfig(
      { KOMGA_URL: URL, KOMGA_USERNAME: "ada", KOMGA_PASSWORD: "correct-horse" },
      [],
    );
    expect(config.username).toBe("ada");
    expect(config.password).toBe("correct-horse");
  });
});
