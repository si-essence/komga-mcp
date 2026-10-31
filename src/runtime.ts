import { CONNECTOR_NAME } from "./constants.js";
import type { Config } from "./config.js";
import { TtlCache } from "./cache.js";
import { HttpClient } from "./http.js";
import { createLogger, type Logger } from "./log.js";
import { SlidingWindowLimiter } from "./rate-limit.js";

export interface Runtime {
  config: Config;
  client: HttpClient;
  secrets: readonly string[];
  logger: Logger;
  cacheTtlSec: number;
}

export interface RuntimeOverrides {
  fetchImpl?: typeof fetch;
  now?: () => number;
  logger?: Logger;
}

export function createRuntime(config: Config, overrides: RuntimeOverrides = {}): Runtime {
  const now = overrides.now ?? Date.now;
  const secrets: string[] = [];
  if (config.apiKey !== undefined) secrets.push(config.apiKey);
  if (config.password !== undefined) secrets.push(config.password);
  const logger = overrides.logger ?? createLogger(secrets);
  const client = new HttpClient({
    baseUrl: config.baseUrl,
    fetchImpl: overrides.fetchImpl ?? fetch,
    timeoutMs: config.timeoutMs,
    secrets,
    cache: new TtlCache(now),
    limiter: new SlidingWindowLimiter(config.perMinute, 60_000, now),
    userAgent: config.userAgent,
    logger,
    apiKey: config.apiKey,
    username: config.username,
    password: config.password,
    label: CONNECTOR_NAME,
  });
  return {
    config,
    client,
    secrets,
    logger,
    cacheTtlSec: config.cacheTtlSec,
  };
}
