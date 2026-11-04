/**
 * Stress entry point: the real Worker, with three local-only changes.
 * 1. Requests to provider hosts go to the fake server at FAKE_URL (`/<host><path>`).
 * 2. With STRESS_BATCH_DROP > 0, RunWorkflow's `createBatch` drops that share of instances: they are not created.
 *    STRESS_BATCH_MODE "once" returns an error entry for each dropped instance on one call only (a transient error);
 *    "always" returns error entries for the same instances on every call; "lost" returns no error entry, so the
 *    instance is silently missing, which is how the production incident looked from the run's side.
 * 3. STRESS_STEP_FAIL makes matching workflow steps fail (see steps.ts).
 */
import { env, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import type { Env } from "../src/env.ts";
import worker from "../src/index.ts";
import type { PageWorkflowParams, RunWorkflowParams } from "../src/workflows.ts";
import { PageWorkflow as BasePageWorkflow, RunWorkflow as BaseRunWorkflow } from "../src/workflows.ts";

import { faultySteps, parseStepFaults } from "./steps.ts";

export { Converter, DocumentWorkflow, ProviderSlots, RunEvents } from "../src/index.ts";

const FAKE_HOSTS = new Set([
  "platform.reducto.ai",
  "api.mistral.ai",
  "api.cohere.com",
  "www.datalab.to",
  "api.extend.ai",
  "api.cloud.llamaindex.ai",
  "api.runpulse.com",
]);

const realFetch = globalThis.fetch;
globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (!FAKE_HOSTS.has(url.hostname)) return realFetch(request);
  const fakeUrl = (env as unknown as { FAKE_URL: string }).FAKE_URL;
  return realFetch(new Request(`${fakeUrl}/${url.hostname}${url.pathname}${url.search}`, request));
};

type PageBinding = Env["PAGE_WORKFLOW"];
type BatchOptions = { instances: Array<WorkflowInstanceCreateOptions<PageWorkflowParams>> };

/** Instance ids already passed to createBatch: "once" only drops an id the first time it is seen. */
const seen = new Set<string>();

/** Stable value in [0, 1) per instance id. */
const unit = (id: string) => {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  // FNV-1a alone clusters on ids that share a long prefix; finish with the murmur3 mixer.
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return ((hash ^ (hash >>> 16)) >>> 0) / 2 ** 32;
};

const shouldDrop = (id: string, share: number, mode: string) => {
  if (mode !== "once") return unit(id) < share;
  if (seen.has(id)) return false;
  seen.add(id);
  return Math.random() < share;
};

const droppingBatch = (binding: PageBinding, share: number, mode: string): PageBinding =>
  new Proxy(binding, {
    get(target, property) {
      if (property !== "createBatch") {
        return (...args: Array<unknown>) =>
          (target as unknown as Record<PropertyKey, (...a: Array<unknown>) => unknown>)[property]?.(...args);
      }
      return async ({ instances }: BatchOptions) => {
        const dropped = instances.filter((instance) => shouldDrop(instance.id ?? "", share, mode));
        const kept = instances.filter((instance) => !dropped.includes(instance));
        const result =
          kept.length === 0
            ? { created: [], errors: [] }
            : ((await target.createBatch({ instances: kept })) as unknown as { created: Array<unknown>; errors: Array<unknown> });
        if (dropped.length > 0) console.log(`[stress] createBatch dropped ${dropped.map((i) => i.id).join(", ")}`);
        return {
          created: result.created,
          errors: [
            ...result.errors,
            ...(mode === "lost" ? [] : dropped).map((instance) => ({
              index: instances.indexOf(instance),
              id: instance.id,
              code: 10001,
              message: "stress: injected createBatch failure",
            })),
          ],
        };
      };
    },
  });

type StressEnv = { STRESS_BATCH_DROP?: string; STRESS_BATCH_MODE?: string; STRESS_STEP_FAIL?: string };

const withStepFaults = (step: WorkflowStep, workerEnv: Env) => {
  const faults = parseStepFaults((workerEnv as unknown as StressEnv).STRESS_STEP_FAIL);
  return faults === undefined ? step : faultySteps(step, faults);
};

export class RunWorkflow extends BaseRunWorkflow {
  constructor(ctx: ExecutionContext, workerEnv: Env) {
    const stress = workerEnv as unknown as StressEnv;
    const share = Number(stress.STRESS_BATCH_DROP ?? "0");
    const mode = stress.STRESS_BATCH_MODE ?? "once";
    super(ctx, share > 0 ? { ...workerEnv, PAGE_WORKFLOW: droppingBatch(workerEnv.PAGE_WORKFLOW, share, mode) } : workerEnv);
  }

  override run(event: Readonly<WorkflowEvent<RunWorkflowParams>>, step: WorkflowStep) {
    return super.run(event, withStepFaults(step, this.env));
  }
}

export class PageWorkflow extends BasePageWorkflow {
  override run(event: Readonly<WorkflowEvent<PageWorkflowParams>>, step: WorkflowStep) {
    return super.run(event, withStepFaults(step, this.env));
  }
}

export default worker;
