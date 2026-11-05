import { Data } from "effect";

/**
 * A failed call to a document provider. `retryable` separates transient failures
 * (network, 408, 409, 425, 429, 5xx) from permanent ones (bad config, bad key, 4xx).
 */
export class ProviderError extends Data.TaggedError("ProviderError")<{
  readonly provider: string;
  readonly retryable: boolean;
  readonly message: string;
  readonly status?: number;
}> {}

export class JudgeError extends Data.TaggedError("JudgeError")<{
  readonly retryable: boolean;
  readonly message: string;
}> {}

const RETRYABLE_STATUSES = new Set([408, 409, 425, 429]);

export const isRetryableStatus = (status: number): boolean => status >= 500 || RETRYABLE_STATUSES.has(status);
