import { extractWithProvider } from "./extract";
import { parseWithProvider } from "./providers";
import { HttpError, parseExtractRequestBody, parseRequestBody } from "./schema";
import type { ExtractResponseBody, ParseResponseBody } from "./schema";
import type { Env } from "./types";

type RouteResult =
  | (Omit<ParseResponseBody, "duration_ms"> & { duration_ms?: number })
  | (Omit<ExtractResponseBody, "duration_ms"> & { duration_ms?: number });

type RouteHandler = (body: unknown, env: Env) => Promise<RouteResult>;

const routes: Record<string, RouteHandler> = {
  "/parse": async (value, env) => {
    const body = parseRequestBody(value);
    const result = await parseWithProvider(body.provider, body.document.url, body.config ?? {}, env);
    return {
      provider: body.provider,
      markdown: result.markdown,
      raw: result.raw,
      cost: result.cost,
      ...(result.duration_ms === undefined ? {} : { duration_ms: result.duration_ms }),
    };
  },
  "/extract": async (value, env) => {
    const body = parseExtractRequestBody(value);
    const result = await extractWithProvider(body.provider, body.document.url, body.schema, body.config ?? {}, env);
    return { provider: body.provider, result: result.result, raw: result.raw, cost: result.cost };
  },
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    const handler = routes[url.pathname];
    if (handler === undefined) {
      return errorResponse(404, "NOT_FOUND", "Endpoint not found.");
    }

    if (request.method !== "POST") {
      return errorResponse(405, "METHOD_NOT_ALLOWED", `Use POST ${url.pathname}.`);
    }

    const authError = authorize(request, env);
    if (authError !== null) return authError;

    try {
      const started = performance.now();
      const body = await handler(await request.json(), env);
      return Response.json({
        ...body,
        duration_ms: body.duration_ms ?? Math.round(performance.now() - started),
      });
    } catch (error) {
      if (error instanceof HttpError) {
        return errorResponse(error.status, error.code, error.message, error.details);
      }

      console.error("competitors worker error", error);
      return errorResponse(502, "PROVIDER_ERROR", "Provider request failed.");
    }
  },
};

function authorize(request: Request, env: Env): Response | null {
  const expected = env.COMPETITORS_API_TOKEN;
  if (!expected) {
    return errorResponse(500, "SERVER_MISCONFIGURED", "Service token is not configured.");
  }

  const header = request.headers.get("authorization");
  if (header !== `Bearer ${expected}`) {
    return errorResponse(401, "UNAUTHORIZED", "Missing or invalid bearer token.");
  }

  return null;
}

function errorResponse(status: number, code: string, message: string, details: Record<string, unknown> | null = null): Response {
  return Response.json({ error: { code, message, ...(details === null ? {} : { details }) } }, { status });
}
