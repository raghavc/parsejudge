import { Effect, Schema } from "effect";
import { HttpClient, type HttpClientError, type HttpClientRequest } from "effect/http";
import { isRetryableStatus, ProviderError } from "./errors.ts";

export interface JsonResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly body: unknown;
}

const MAX_ERROR_BODY = 500;

/** Bounds one request below the 5-minute workflow step timeout, so a hung call fails with its own message. */
export const REQUEST_TIMEOUT = "3 minutes";

/** AWS JSON APIs report throttling as HTTP 400 with one of these error types. */
const AWS_THROTTLES =
  /"__type":"(?:[^"#]*#)?(ThrottlingException|ProvisionedThroughputExceededException|LimitExceededException)"/;

/** True when a failed response is worth retrying: a transient status, or an AWS throttle sent as 400. */
export const isRetryableResponse = (status: number, body: string) => isRetryableStatus(status) || AWS_THROTTLES.test(body);

/** The start of a response body, for error messages. */
export const snippet = (body: unknown): string =>
  (typeof body === "string" ? body : (JSON.stringify(body) ?? String(body))).slice(0, MAX_ERROR_BODY);

/** The client's message plus its cause: a transport error's own message omits the network error behind it. */
export const httpErrorMessage = (error: HttpClientError.HttpClientError): string => {
  const cause: unknown = "cause" in error.reason ? error.reason.cause : undefined;
  return cause instanceof Error ? `${error.message}: ${cause.message}` : error.message;
};

/** Sends a request and decodes a JSON body (`null` when empty). Non-2xx responses fail with a classified ProviderError. */
export const sendJson = Effect.fn("http.sendJson")(function* (provider: string, request: HttpClientRequest.HttpClientRequest) {
  const client = yield* HttpClient.HttpClient;
  return yield* Effect.gen(function* () {
    const response = yield* client
      .execute(request)
      .pipe(Effect.mapError((error) => new ProviderError({ provider, retryable: true, message: httpErrorMessage(error) })));
    if (response.status < 200 || response.status >= 300) {
      const text = yield* response.text.pipe(
        Effect.catch((error) => Effect.succeed(`(body unreadable: ${httpErrorMessage(error)})`)),
      );
      return yield* new ProviderError({
        provider,
        retryable: isRetryableResponse(response.status, text),
        status: response.status,
        message: `HTTP ${response.status}: ${text.slice(0, MAX_ERROR_BODY)}`,
      });
    }
    const text = yield* response.text.pipe(
      Effect.mapError((error) => new ProviderError({ provider, retryable: true, message: httpErrorMessage(error) })),
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
  }).pipe(
    Effect.timeoutOrElse({
      duration: REQUEST_TIMEOUT,
      orElse: () =>
        Effect.fail(new ProviderError({ provider, retryable: true, message: `Request timed out after ${REQUEST_TIMEOUT}` })),
    }),
  );
});

/**
 * Decodes the fields an adapter reads from a 2xx body. A body without them (empty, an error object, a changed API)
 * fails with the schema issue and the body text instead of becoming an empty parse.
 */
export const decodeBody = <A>(provider: string, schema: Schema.Decoder<A>, body: unknown) =>
  Schema.decodeUnknownEffect(schema)(body).pipe(
    Effect.mapError(
      (error) =>
        new ProviderError({
          provider,
          retryable: true,
          message: `Unexpected response: ${error.message}; body: ${snippet(body)}`,
        }),
    ),
  );
