export const CONNECTOR_ERROR_CODES = [
  "config",
  "input",
  "unauthorized",
  "forbidden",
  "not_found",
  "rate_limit",
  "upstream",
  "network",
  "timeout",
] as const;

export type ConnectorErrorCode = (typeof CONNECTOR_ERROR_CODES)[number];

export class ConnectorError extends Error {
  readonly code: ConnectorErrorCode;
  readonly retryAfterSeconds: number | null;

  constructor(code: ConnectorErrorCode, message: string, retryAfterSeconds: number | null = null) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export function errorPrefix(code: ConnectorErrorCode): string {
  switch (code) {
    case "config":
      return "[config] ";
    case "input":
      return "[input] ";
    case "unauthorized":
      return "[unauthorized] ";
    case "forbidden":
      return "[forbidden] ";
    case "not_found":
      return "[not-found] ";
    case "rate_limit":
      return "[rate-limit] ";
    case "upstream":
      return "[upstream] ";
    case "network":
      return "[network] ";
    case "timeout":
      return "[timeout] ";
    default: {
      const neverCode: never = code;
      return neverCode;
    }
  }
}
