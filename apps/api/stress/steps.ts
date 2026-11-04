/**
 * Step faults: makes a share of `step.do` calls fail as if the step had used up its retries (for example during a
 * D1 or Durable Object outage). The failure is thrown inside the step callback as a NonRetryableError, so the
 * Workflows engine records it like a real step failure.
 */
import type { WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";

/** `STRESS_STEP_FAIL` is "<share>:<regex>", for example "0.05:^(record|report)". Empty means no faults. */
export const parseStepFaults = (value: string | undefined): { share: number; names: RegExp } | undefined => {
  const match = /^([0-9.]+):(.+)$/.exec(value ?? "");
  if (match === null || Number(match[1]) <= 0) return undefined;
  return { share: Number(match[1]), names: new RegExp(match[2] ?? "") };
};

export const faultySteps = (step: WorkflowStep, faults: { share: number; names: RegExp }): WorkflowStep =>
  new Proxy(step, {
    get(target, property) {
      // `step` is an RPC stub: call its methods through it, never `.bind` them (that is sent as an RPC call).
      if (property !== "do")
        return (...args: Array<unknown>) =>
          (target as unknown as Record<PropertyKey, (...a: Array<unknown>) => unknown>)[property]?.(...args);
      return (name: string, ...rest: Array<unknown>) => {
        const callback = rest.pop() as () => Promise<unknown>;
        const inject = faults.names.test(name) && Math.random() < faults.share;
        const wrapped = async () => {
          if (inject) {
            console.log(`[stress] step failure injected: ${name}`);
            throw new NonRetryableError(`stress: injected failure in step "${name}"`);
          }
          return callback();
        };
        return (target.do as (...args: Array<unknown>) => Promise<unknown>)(name, ...rest, wrapped);
      };
    },
  });
