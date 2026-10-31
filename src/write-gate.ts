import type { QueryMap } from "./http.js";
import { redact, redactUnknown } from "./redact.js";
import type { Runtime } from "./runtime.js";

export const WRITES_DISABLED = "KOMGA_ALLOW_WRITES is not true. The write was not sent.";

export interface WritePlan {
  readonly method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  readonly path: string;
  readonly query: QueryMap | undefined;
  readonly body: unknown;
  readonly summary: string;
  readonly warnings: readonly string[];
  readonly revealSecret: boolean;
}

export function previewWrite(
  plan: WritePlan,
  blocked: boolean,
  reason: string | undefined,
  secrets: readonly string[],
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    executed: false,
    dry_run: true,
    blocked,
    method: plan.method,
    path: redact(plan.path, secrets),
    summary: plan.summary,
    warnings: [...plan.warnings],
  };
  if (reason !== undefined) payload["reason"] = reason;
  if (plan.query !== undefined) payload["query"] = redactUnknown(plan.query, secrets);
  if (plan.body !== undefined) payload["body"] = redactUnknown(plan.body, secrets);
  return payload;
}

export function decideWrite(
  allowWrites: boolean,
  confirm: true | undefined,
  plan: WritePlan,
  secrets: readonly string[],
): { kind: "preview"; payload: Record<string, unknown> } | { kind: "execute" } {
  if (confirm !== true) {
    return { kind: "preview", payload: previewWrite(plan, false, undefined, secrets) };
  }
  if (!allowWrites) {
    return { kind: "preview", payload: previewWrite(plan, true, WRITES_DISABLED, secrets) };
  }
  return { kind: "execute" };
}

export async function withWrite<T>(
  runtime: Runtime,
  confirm: true | undefined,
  plan: WritePlan,
  run: () => Promise<T>,
): Promise<Record<string, unknown>> {
  const decision = decideWrite(runtime.config.allowWrites, confirm, plan, runtime.secrets);
  if (decision.kind === "preview") return decision.payload;
  const result = await run();
  const payload: Record<string, unknown> = {
    executed: true,
    dry_run: false,
    blocked: false,
    warnings: [...plan.warnings],
    result,
  };
  if (plan.revealSecret) payload["shown_once"] = true;
  return payload;
}
