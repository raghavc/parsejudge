import { Data, Effect } from "effect";

/** A D1, R2, Durable Object or Workflows call failed. A workflow step retries it. */
export class StorageFailed extends Data.TaggedError("StorageFailed")<{ readonly message: string }> {
  readonly retryable = true;
}

export const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** A platform binding call as an Effect that fails with `StorageFailed`. */
export const storage = <A>(call: () => Promise<A>) =>
  Effect.tryPromise({ try: call, catch: (error) => new StorageFailed({ message: messageOf(error) }) });
