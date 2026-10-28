import { Effect, type Option } from "effect";
import type { HttpClient } from "effect/http";
import type { Cost, ProviderId } from "./domain.ts";
import { ProviderError } from "./errors.ts";

/** One page of a document, as a single-page PDF and a rendered PNG. URLs are short-lived and public. */
export interface PageInput {
  readonly pdfUrl: string;
  readonly imageUrl: string;
  readonly pdf: Effect.Effect<Uint8Array, ProviderError>;
}

export interface ParseOutput {
  readonly markdown: string;
  readonly raw: unknown;
  /** Cost reported by the provider for this call. Absent when the provider does not report it. */
  readonly reportedCost?: Cost;
}

/** Result of a submit call. Async providers return a job reference to poll later. */
export type Submission =
  | { readonly _tag: "Done"; readonly output: ParseOutput }
  | { readonly _tag: "Pending"; readonly job: string };

export const done = (output: ParseOutput): Submission => ({ _tag: "Done", output });
export const pending = (job: string): Submission => ({ _tag: "Pending", job });

export type Credentials = Readonly<Record<string, string>>;
export type ProviderConfig = Readonly<Record<string, unknown>>;

export interface ProviderAdapter {
  readonly id: ProviderId;
  /** Credential names the adapter reads, e.g. `AZURE_DI_KEY`. */
  readonly credentialKeys: ReadonlyArray<string>;
  readonly submit: (
    page: PageInput,
    config: ProviderConfig,
    credentials: Credentials,
  ) => Effect.Effect<Submission, ProviderError, HttpClient.HttpClient>;
  /** Returns `None` while the job is still running. Required when `submit` can return `Pending`. */
  readonly poll?: (
    job: string,
    credentials: Credentials,
  ) => Effect.Effect<Option.Option<ParseOutput>, ProviderError, HttpClient.HttpClient>;
}

export const credential = (provider: ProviderId, credentials: Credentials, key: string) => {
  const value = credentials[key];
  return value === undefined || value.length === 0
    ? Effect.fail(new ProviderError({ provider, retryable: false, message: `Missing credential ${key}` }))
    : Effect.succeed(value);
};

export const failure = (provider: ProviderId, message: string, retryable = false) =>
  new ProviderError({ provider, retryable, message });
