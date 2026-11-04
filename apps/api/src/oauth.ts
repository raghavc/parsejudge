import {
  AuthorizationError,
  CimdFetchError,
  type ConsentDescription,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { Cause, Data, Effect } from "effect";
import { sessionUser } from "./auth.ts";
import type { Env } from "./env.ts";

export const SCOPE = "parsejudge";
export const AUTHORIZE_PATH = "/oauth/authorize";

/** What a connected agent's tokens carry, as `ctx.props` in the MCP handler. */
export interface AgentProps {
  readonly userId: string;
}

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

const page = (title: string, body: string, status = 200, headers = new Headers()) => {
  headers.set("content-type", "text/html; charset=utf-8");
  return new Response(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · ParseJudge</title>
<style>
body{margin:0;font:15px/22px Inter,system-ui,sans-serif;color:#111;background:#fff}
main{max-width:440px;margin:0 auto;padding:96px 24px}
h1{font-size:28px;line-height:34px;font-weight:500;letter-spacing:-.02em;margin:0 0 16px}
p{margin:0 0 12px;color:#555}strong{color:#111;font-weight:500}
.warn{border:1px solid #e5c07b;background:#fdf6e3;padding:10px 12px;color:#111}
.row{display:flex;gap:12px;margin-top:28px}
button,a.button{font:inherit;padding:10px 18px;border:1px solid #111;background:#fff;color:#111;cursor:pointer;text-decoration:none}
.primary{background:#111;color:#fff}
</style>
<main><div style="font-weight:500;margin-bottom:48px">Parse Judge</div>${body}</main></html>`,
    { status, headers },
  );
};

const consentPage = (details: ConsentDescription, handle: string, email: string, headers: Headers) =>
  page(
    `Connect ${details.clientName}`,
    `<h1>Allow ${escapeHtml(details.clientName)} to use your ParseJudge account?</h1>
<p>It will act as <strong>${escapeHtml(email)}</strong>: upload documents, start runs with your keys, read, share and delete your reports, and change your settings.</p>
<p>${
      details.clientDomain
        ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
        : "This app registered itself, so its name is not verified."
    } Access goes to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>
${details.redirectIsLoopback ? '<p class="warn">This sends access to an app on your computer. Continue only if you just started connecting from it.</p>' : ""}
<p>You can disconnect it at any time in Account.</p>
<form method="post" class="row">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<button class="primary" name="decision" value="approve">Allow</button>
<button name="decision" value="deny">Deny</button>
</form>`,
    200,
    headers,
  );

/** GET shows the consent page (or asks the user to sign in first); POST records the decision. */
export const authorize = (request: Request, env: Env, oauth: OAuthHelpers) =>
  Effect.gen(function* () {
    const user = yield* sessionUser(env, request.headers.get("cookie"));
    if (request.method === "POST") {
      if (user === null) return page("Sign in", "<h1>Your session ended</h1><p>Start connecting again from your agent.</p>", 401);
      const form = yield* Effect.tryPromise(() => request.formData()).pipe(Effect.orElseSucceed(() => null));
      if (form === null)
        return page("Could not connect", "<h1>Could not connect</h1><p>Start connecting again from your agent.</p>", 400);
      const handle = String(form.get("handle") ?? "");
      if (form.get("decision") !== "approve") {
        const denied = yield* Effect.promise(() => oauth.denyConsent(request, handle));
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const approved = yield* Effect.promise(() => oauth.approveConsent(request, handle));
      const props: AgentProps = { userId: user.id };
      const { redirectTo } = yield* Effect.promise(() =>
        oauth.completeAuthorization({
          request: approved.request,
          userId: user.id,
          metadata: {},
          scope: approved.request.scope,
          props,
        }),
      );
      approved.headers.set("location", redirectTo);
      return new Response(null, { status: 302, headers: approved.headers });
    }
    const authRequest = yield* Effect.promise(() => oauth.parseAuthRequest(request));
    const details = yield* Effect.promise(() => oauth.describeConsent(authRequest));
    if (user === null) {
      const url = new URL(request.url);
      const next = encodeURIComponent(url.pathname + url.search);
      return page(
        "Sign in",
        `<h1>Sign in to connect ${escapeHtml(details.clientName)}</h1>
<p>Sign in to ParseJudge first. You'll come back here to allow or deny access.</p>
<div class="row"><a class="button primary" href="/signin?next=${next}">Sign in</a></div>`,
      );
    }
    const consent = yield* Effect.promise(() => oauth.beginConsent(authRequest));
    return consentPage(details, consent.handle, user.email, consent.headers);
  }).pipe(
    Effect.catchCause((cause) => {
      const error = Cause.squash(cause);
      if (error instanceof AuthorizationError && error.redirectTo)
        return Effect.succeed(Response.redirect(error.redirectTo, 302));
      if (error instanceof AuthorizationError || error instanceof CimdFetchError) {
        const message = error instanceof AuthorizationError ? error.description : "This app could not be verified.";
        return Effect.succeed(page("Could not connect", `<h1>Could not connect</h1><p>${escapeHtml(message ?? "")}</p>`, 400));
      }
      return Effect.logError({ event: "oauth_authorize_failed", method: request.method, error: String(error) }).pipe(
        Effect.as(
          page("Could not connect", "<h1>Could not connect</h1><p>Something went wrong on our side. Try again.</p>", 500),
        ),
      );
    }),
  );

const grants = Effect.fn("grants")(function* (oauth: OAuthHelpers, userId: string) {
  const all = [];
  let cursor: string | undefined;
  do {
    const after = cursor;
    const result = yield* Effect.promise(() => oauth.listUserGrants(userId, after === undefined ? undefined : { cursor: after }));
    all.push(...result.items);
    cursor = result.cursor;
  } while (cursor !== undefined);
  return all;
});

/** The agents a user connected: one per grant, newest first. */
export const listAgents = (oauth: OAuthHelpers, userId: string) =>
  grants(oauth, userId).pipe(
    Effect.flatMap((all) =>
      Effect.forEach(
        all,
        (grant) =>
          Effect.promise(() => oauth.lookupClient(grant.clientId)).pipe(
            Effect.map((client) => ({
              id: grant.id,
              name: client?.clientName ?? grant.clientId,
              connectedAt: grant.createdAt * 1000,
            })),
          ),
        { concurrency: "unbounded" },
      ),
    ),
    Effect.map((agents) => agents.sort((a, b) => b.connectedAt - a.connectedAt)),
  );

export class RevokeFailed extends Data.TaggedError("RevokeFailed")<{ readonly message: string }> {}

/** Revokes every grant, carrying on past a failed one; fails afterwards if any could not be revoked. */
export const revokeAgents = (oauth: OAuthHelpers, userId: string) =>
  grants(oauth, userId).pipe(
    Effect.catchDefect((error) => Effect.fail(new RevokeFailed({ message: String(error) }))),
    Effect.flatMap((all) =>
      Effect.all(
        all.map((grant) =>
          Effect.tryPromise({
            try: () => oauth.revokeGrant(grant.id, userId),
            catch: (error) => new RevokeFailed({ message: String(error) }),
          }),
        ),
        { concurrency: 8, mode: "result" },
      ),
    ),
    Effect.flatMap((results) => {
      const failed = results.flatMap((result) => (result._tag === "Failure" ? [result.failure.message] : []));
      return failed.length === 0
        ? Effect.void
        : Effect.fail(new RevokeFailed({ message: `${failed.length} of ${results.length} grants: ${failed[0]}` }));
    }),
  );

const AGENT_PATH = /^\/v1\/agents\/([^/]+)$/;

/** GET /v1/agents and DELETE /v1/agents/:id for the signed-in browser; null for any other path. */
export const handleAgents = (request: Request, env: Env, oauth: OAuthHelpers) => {
  const { pathname } = new URL(request.url);
  const one = AGENT_PATH.exec(pathname);
  if (pathname !== "/v1/agents" && one === null) return null;
  return Effect.gen(function* () {
    const user = yield* sessionUser(env, request.headers.get("cookie"));
    if (user === null) return Response.json({ _tag: "Unauthorized" }, { status: 401 });
    if (pathname === "/v1/agents" && request.method === "GET") return Response.json(yield* listAgents(oauth, user.id));
    if (one?.[1] !== undefined && request.method === "DELETE") {
      const grantId = decodeURIComponent(one[1]);
      yield* Effect.promise(() => oauth.revokeGrant(grantId, user.id));
      return new Response(null, { status: 204 });
    }
    return new Response("Method not allowed", { status: 405 });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logError({ event: "agents_route_failed", method: request.method, error: String(Cause.squash(cause)) }).pipe(
        Effect.as(Response.json({ error: "Could not load connected agents. Try again." }, { status: 500 })),
      ),
    ),
  );
};
