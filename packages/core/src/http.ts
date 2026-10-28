import { Effect } from "effect";
import { HttpClient, type HttpClientRequest } from "effect/http";
import { isRetryableStatus, ProviderError } from "./errors.ts";

export interface JsonResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: unknown;
}

const MAX_ERROR_BODY = 500;

/** Sends a request and decodes a JSON body (`null` when empty). Non-2xx responses fail with a classified ProviderError. */
export const sendJson = Effect.fn("http.sendJson")(function* (provider: string, request: HttpClientRequest.HttpClientRequest) {
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(request)
    .pipe(Effect.mapError((error) => new ProviderError({ provider, retryable: true, message: error.message })));
  if (response.status < 200 || response.status >= 300) {
    const text = yield* response.text.pipe(Effect.orElseSucceed(() => ""));
    return yield* new ProviderError({
      provider,
      retryable: isRetryableStatus(response.status),
      status: response.status,
      message: `HTTP ${response.status}: ${text.slice(0, MAX_ERROR_BODY)}`,
    });
  }
  const text = yield* response.text.pipe(
    Effect.mapError((error) => new ProviderError({ provider, retryable: true, message: error.message })),
  );
  const body: unknown =
    text.length === 0
      ? null
      : yield* Effect.try({
          try: () => JSON.parse(text) as unknown,
          catch: () =>
            new ProviderError({ provider, retryable: true, message: `Invalid JSON: ${text.slice(0, MAX_ERROR_BODY)}` }),
        });
  return { status: response.status, headers: response.headers, body } satisfies JsonResponse;
});
