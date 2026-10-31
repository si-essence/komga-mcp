import { dropStackKeys } from "./parse.js";
import { redactRecord } from "./redact.js";

interface MintedSecret {
  readonly path: readonly string[];
  readonly value: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function collectMinted(value: unknown, path: string[], out: MintedSecret[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectMinted(item, [...path, String(index)], out);
    });
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    const next = [...path, key];
    if (key === "key" && typeof entry === "string") {
      out.push({ path: next, value: entry });
      continue;
    }
    collectMinted(entry, next, out);
  }
}

function setPath(target: unknown, path: readonly string[], value: string): void {
  let cursor: unknown = target;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index];
    if (key === undefined) return;
    if (Array.isArray(cursor)) {
      cursor = cursor[Number(key)];
      continue;
    }
    if (!isRecord(cursor)) return;
    cursor = cursor[key];
  }
  const leaf = path[path.length - 1];
  if (leaf === undefined) return;
  if (Array.isArray(cursor)) {
    cursor[Number(leaf)] = value;
    return;
  }
  if (!isRecord(cursor)) return;
  cursor[leaf] = value;
}

export const SHOWN_ONCE_NOTE = "This API key is shown only once. List and get calls redact it.";

export function presentToolResult(
  value: Record<string, unknown>,
  secrets: readonly string[],
): Record<string, unknown> {
  const stripped = dropStackKeys(value);
  const record = isRecord(stripped) ? stripped : { value: stripped };
  const reveal = record["shown_once"] === true;
  const minted = reveal ? collectList(record) : [];
  const redacted = redactRecord(record, secrets);
  if (!reveal) return redacted;
  for (const item of minted) {
    setPath(redacted, item.path, item.value);
  }
  redacted["shown_once"] = true;
  redacted["note"] = SHOWN_ONCE_NOTE;
  return redacted;
}

function collectList(value: Record<string, unknown>): MintedSecret[] {
  const out: MintedSecret[] = [];
  collectMinted(value, [], out);
  return out;
}
