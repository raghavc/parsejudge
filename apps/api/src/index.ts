import { getOAuthApi, type OAuthHelpers, OAuthProvider, type OAuthProviderOptions } from "@cloudflare/workers-oauth-provider";
import { handler } from "./api.ts";
import { cleanUpAuth, handleAuth, sessionUser } from "./auth.ts";
import { verifyBlobUrl } from "./blobs.ts";
import type { Env } from "./env.ts";
import { INTERNAL_HEADER, internalHeader } from "./internal.ts";
import { mcpHandler } from "./mcp.ts";
import { AUTHORIZE_PATH, authorize, handleAgents, revokeAgents, SCOPE } from "./oauth.ts";
import { uploadUser } from "./uploads.ts";

export { Converter } from "./converter.ts";
export { RunEvents } from "./events.ts";
export { ProviderSlots } from "./slots.ts";
export { DocumentWorkflow, PageWorkflow, RunWorkflow } from "./workflows.ts";

const EVENTS_PATH = /^\/v1\/runs\/([^/]+)\/events$/;
const UPLOAD_PATH = /^\/v1\/uploads\/([^/]+)$/;

/** PUT /v1/uploads/<token>?filename=: an upload through a URL from the MCP create_upload_url tool. */
const signedUpload = async (request: Request, env: Env, token: string) => {
  if (request.method !== "PUT") return new Response("Method not allowed", { status: 405 });
  const userId = await uploadUser(env, decodeURIComponent(token));
  if (userId === null) return Response.json({ error: "This upload URL is invalid or expired." }, { status: 403 });
  const filename = new URL(request.url).searchParams.get("filename") ?? "document";
  return handler(
    new Request(new URL(`/v1/documents?filename=${encodeURIComponent(filename)}`, request.url), {
      method: "POST",
      headers: { [INTERNAL_HEADER]: internalHeader(userId), "content-type": "application/octet-stream" },
      body: await request.arrayBuffer(),
    }),
  );
};

const app = {
  async fetch(request: Request, env: Env & { OAUTH_PROVIDER: OAuthHelpers }): Promise<Response> {
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
    const upload = UPLOAD_PATH.exec(url.pathname);
    if (upload?.[1] !== undefined) return signedUpload(request, env, upload[1]);
    if (url.pathname === AUTHORIZE_PATH) return authorize(request, env, env.OAUTH_PROVIDER);
    if (request.method !== "GET" && request.method !== "HEAD" && url.pathname.startsWith("/v1/")) {
      const origin = request.headers.get("origin");
      if (origin !== null && origin !== url.origin) return new Response("Forbidden", { status: 403 });
    }
    const auth = handleAuth(env, request);
    if (auth !== null) return auth;
    const agents = await handleAgents(request, env, env.OAUTH_PROVIDER);
    if (agents !== null) return agents;
    const events = EVENTS_PATH.exec(url.pathname);
    if (events?.[1] !== undefined) return env.RUN_EVENTS.get(env.RUN_EVENTS.idFromName(events[1])).fetch(request);
    if (url.pathname === "/v1/account" && request.method === "DELETE") {
      const user = await sessionUser(env, request.headers.get("cookie"));
      const response = await handler(request);
      if (response.ok && user !== null) await revokeAgents(env.OAUTH_PROVIDER, user.id);
      return response;
    }
    // Strip any forged internal identity before the API sees the request.
    if (request.headers.has(INTERNAL_HEADER)) {
      const headers = new Headers(request.headers);
      headers.delete(INTERNAL_HEADER);
      return handler(new Request(request, { headers }));
    }
    return handler(request);
  },
};

/** One provider per origin: the resource metadata names the /mcp URL the client used. */
const providers = new Map<string, { options: OAuthProviderOptions<Env>; provider: OAuthProvider<Env> }>();

const oauthFor = (origin: string) => {
  let entry = providers.get(origin);
  if (entry === undefined) {
    const options: OAuthProviderOptions<Env> = {
      apiRoute: "/mcp",
      apiHandler: mcpHandler((env) => getOAuthApi(options, env)),
      defaultHandler: app as unknown as ExportedHandler<Env>,
      authorizeEndpoint: AUTHORIZE_PATH,
      tokenEndpoint: "/oauth/token",
      clientRegistrationEndpoint: "/oauth/register",
      scopesSupported: [SCOPE],
      resourceMetadata: { resource: `${origin}/mcp`, authorization_servers: [origin] },
      requiredScopes: [SCOPE],
      clientIdMetadataDocumentEnabled: true,
    };
    entry = { options, provider: new OAuthProvider<Env>(options) };
    providers.set(origin, entry);
  }
  return entry.provider;
};

export default {
  fetch: (request, env, ctx) => oauthFor(new URL(request.url).origin).fetch(request, env, ctx),
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(cleanUpAuth(env));
  },
} satisfies ExportedHandler<Env>;
