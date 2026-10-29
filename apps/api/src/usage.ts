import type { Env } from "./env.ts";

/** One paid call: a provider parse, a judge call, or a small-model call (page note, error locations, run title). */
export interface Usage {
  readonly kind: "provider" | "judge" | "note" | "locate" | "title";
  /** Preset id for a provider parse, model id for a model call. */
  readonly name: string;
  readonly runId?: string;
  readonly pageId?: string;
  readonly status: "ok" | "failed";
  readonly costUsd: number;
  readonly latencyMs: number;
  readonly queueMs?: number;
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly reasoningTokens?: number;
}

/**
 * Logs the call to Workers Logs and writes it to the Analytics Engine dataset (`USAGE`, if bound).
 * Columns: index1 = run id; blob1..5 = kind, name, run id, page id, status;
 * double1..6 = cost USD, latency ms, queue ms, prompt tokens, completion tokens, reasoning tokens.
 */
export const recordUsage = (env: Env, usage: Usage): void => {
  console.log(JSON.stringify({ event: "usage", ...usage }));
  env.USAGE?.writeDataPoint({
    indexes: [usage.runId ?? ""],
    blobs: [usage.kind, usage.name, usage.runId ?? "", usage.pageId ?? "", usage.status],
    doubles: [
      usage.costUsd,
      usage.latencyMs,
      usage.queueMs ?? 0,
      usage.promptTokens ?? 0,
      usage.completionTokens ?? 0,
      usage.reasoningTokens ?? 0,
    ],
  });
};

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** Cost and tokens from the `usage` object OpenRouter returns with every completion. */
export const openRouterUsage = (usage: unknown) => {
  const u = (usage ?? {}) as Record<string, unknown>;
  const details = (u.completion_tokens_details ?? {}) as Record<string, unknown>;
  return {
    costUsd: num(u.cost),
    promptTokens: num(u.prompt_tokens),
    completionTokens: num(u.completion_tokens),
    reasoningTokens: num(details.reasoning_tokens),
  };
};
