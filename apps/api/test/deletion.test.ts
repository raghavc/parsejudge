import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { stopRun } from "../src/deletion.ts";

const fakeEnv = (getRun: () => Promise<unknown>) => {
  const updates: Array<string> = [];
  const statement = (sql: string) => ({
    bind: () => ({
      all: async () => ({ results: [] }),
      run: async () => {
        updates.push(sql);
      },
    }),
  });
  return { env: { RUN_WORKFLOW: { get: getRun }, PAGE_WORKFLOW: { get: getRun }, DB: { prepare: statement } } as never, updates };
};

describe("stopRun", () => {
  it("marks a run stopped when its workflow was never created", async () => {
    const { env, updates } = fakeEnv(() => Promise.reject(new Error("(instance.not_found) Instance does not exist")));
    await Effect.runPromise(stopRun(env, "run"));
    expect(updates).toHaveLength(1);
  });

  it("fails, leaving the run as is, when terminating its workflow fails", async () => {
    const { env, updates } = fakeEnv(() => Promise.reject(new Error("Workflows API unavailable")));
    await expect(Effect.runPromise(stopRun(env, "run"))).rejects.toThrow("Workflows API unavailable");
    expect(updates).toHaveLength(0);
  });
});
