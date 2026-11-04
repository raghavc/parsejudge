# Effect lint rules

Backend code (`packages/core/src`, `apps/api/src`) is Effect-native. Two tools enforce this. Both fail the gate.

- `pnpm check`: TypeScript with the `@effect/language-service` plugin (`tsconfig.backend.json`). `pnpm install` runs `effect-language-service patch`, so plain `tsc` reports Effect diagnostics and exits non-zero on them. Test files use `test/tsconfig.json`, which does not load the plugin.
- `pnpm lint` (`biome check .`): Biome GritQL plugins from `@catenarycloud/linteffect` and `lint/*.grit`, scoped to backend files in `biome.json` `overrides`.

## Rules

| Do not | Do | Enforced by |
| --- | --- | --- |
| `try` / `catch` / `finally` | `Effect.try`, `Effect.tryPromise`, `Effect.catchTag`, `Effect.ensuring` | linteffect `no-try-catch`, LSP `tryCatchInEffectGen` |
| `throw` | `return yield* new SomeError(...)` with a `Data.TaggedError` | linteffect `no-throw-statement` |
| global `fetch` | `HttpClient` from `effect/http`, `FetchHttpClient.layer` at the boundary | LSP `globalFetch`, `globalFetchInEffect` |
| `new Promise`, `.then`, `.catch`, `.finally` | `Effect.tryPromise`, `Effect.flatMap`, `Effect.catch*` | LSP `newPromise`, `lint/no-promise-chain.grit` |
| `JSON.parse` | `Schema.decodeUnknownEffect(Schema.fromJsonString(schema))` | `lint/no-json-parse.grit` |
| `console.*` | `Effect.logError`, `Effect.logWarning`, `Effect.logInfo` | LSP `globalConsole`, `globalConsoleInEffect` |
| an Effect that is never yielded or run | yield it, return it, or run it at the boundary | LSP `floatingEffect` |
| `async` functions | `Effect.gen` / `Effect.fn` | LSP `asyncFunction`, linteffect `no-effect-async` |
| `Effect.runPromise` / `runFork` / `runSync` in library code | return the Effect; run it at a platform boundary | `lint/no-effect-run.grit` |
| `Effect.Do` / `Effect.bind`, nested `Effect.gen`, console in `Effect.sync` | `Effect.gen` | linteffect |
| extending `Error` | `Data.TaggedError` | LSP `extendsNativeError` |

There are no suppression comments in backend code. Do not add any.

## Platform boundaries

Cloudflare calls these and needs a `Promise` back. Each one is a plain (non-`async`) function that returns a single `Effect.runPromise(...)`:

- the Worker `fetch` and `scheduled` handlers (`index.ts`)
- `WorkflowEntrypoint.run` and `step.do` callbacks (`workflows.ts`, through `runStep` in `run.ts`)
- Durable Object methods (`slots.ts`, `events.ts`)
- `@cloudflare/workers-oauth-provider` and MCP agent callbacks (`index.ts`, `oauth.ts`, `mcp.ts`)

Only the files listed in the second `biome.json` override are allowed to call `Effect.run*`. Add a file there only if Cloudflare calls into it directly.

`runStep` keeps the Workflows retry contract: a retryable failure becomes `Error` (Workflows retries the step) and a non-retryable failure becomes `NonRetryableError` (the step fails at once).
