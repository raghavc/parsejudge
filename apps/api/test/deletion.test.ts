import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { stopRun } from "../src/deletion.ts";

const fakeEnv = (getRun: () => Promise<unknown>) => {
  const updates: Array<string> = [];
  const statement = (sql: string) => ({
    bind: () => ({
      sql,
      all: async () => ({ results: [] }),
      run: async () => {
        updates.push(sql);
      },
    }),
  });
  const batch = async (statements: ReadonlyArray<{ sql: string }>) => {
    for (const s of statements) updates.push(s.sql);
    return [];
  };
  return {
    env: { RUN_WORKFLOW: { get: getRun }, PAGE_WORKFLOW: { get: getRun }, DB: { prepare: statement, batch } } as never,
    updates,
  };
};

describe("stopRun", () => {
  it("marks a run stopped and deletes its keys when its workflow was never created", async () => {
    const { env, updates } = fakeEnv(() => Promise.reject(new Error("(instance.not_found) Instance does not exist")));
    await Effect.runPromise(stopRun(env, "run"));
    expect(updates).toHaveLength(2);
    expect(updates[1]).toContain("DELETE FROM run_credentials");
  });

  it("fails, leaving the run as is, when terminating its workflow fails", async () => {
    const { env, updates } = fakeEnv(() => Promise.reject(new Error("Workflows API unavailable")));
    await expect(Effect.runPromise(stopRun(env, "run"))).rejects.toThrow("Workflows API unavailable");
    expect(updates).toHaveLength(0);
  });
});
