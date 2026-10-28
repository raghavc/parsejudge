import { handler } from "./api.ts";
import { verifyBlobUrl } from "./blobs.ts";
import type { Env } from "./env.ts";

export { RunEvents } from "./events.ts";
export { PageWorkflow, RunWorkflow } from "./workflows.ts";

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
    const events = EVENTS_PATH.exec(url.pathname);
    if (events?.[1] !== undefined) return env.RUN_EVENTS.get(env.RUN_EVENTS.idFromName(events[1])).fetch(request);
    return handler(request);
  },
} satisfies ExportedHandler<Env>;
