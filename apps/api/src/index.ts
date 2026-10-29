import { handler } from "./api.ts";
import { cleanUpAuth, handleAuth } from "./auth.ts";
import { verifyBlobUrl } from "./blobs.ts";
import type { Env } from "./env.ts";

export { Converter } from "./converter.ts";
export { RunEvents } from "./events.ts";
export { ProviderSlots } from "./slots.ts";
export { DocumentWorkflow, PageWorkflow, RunWorkflow } from "./workflows.ts";

const EVENTS_PATH = /^\/v1\/runs\/([^/]+)\/events$/;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/blobs/")) {
      const key = decodeURIComponent(url.pathname.slice("/blobs/".length));
      if (!(await verifyBlobUrl(env.BLOB_SIGNING_KEY, key, url.searchParams.get("exp"), url.searchParams.get("sig")))) {
        return new Response("Forbidden", { status: 403 });
      }
      const object = await env.BLOBS.get(key);
      if (object === null) return new Response("Not found", { status: 404 });
      return new Response(object.body, { headers: { "content-type": key.endsWith(".png") ? "image/png" : "application/pdf" } });
    }
    // Sign-in codes, links and sessions are HMACs under AUTH_KEY; without a real key, serve nothing.
    if ((env.AUTH_KEY ?? "").length < 32) return new Response("AUTH_KEY is not set", { status: 500 });
    if (request.method !== "GET" && request.method !== "HEAD" && url.pathname.startsWith("/v1/")) {
      const origin = request.headers.get("origin");
      if (origin !== null && origin !== url.origin) return new Response("Forbidden", { status: 403 });
    }
    const auth = handleAuth(env, request);
    if (auth !== null) return auth;
    const events = EVENTS_PATH.exec(url.pathname);
    if (events?.[1] !== undefined) return env.RUN_EVENTS.get(env.RUN_EVENTS.idFromName(events[1])).fetch(request);
    return handler(request);
  },
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(cleanUpAuth(env));
  },
} satisfies ExportedHandler<Env>;
