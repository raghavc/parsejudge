/**
 * Fake provider and judge HTTP server. The stress Worker sends Reducto, Mistral and OpenRouter calls here, and the
 * judge's OpenAI token exchange (`/oauth/token`) and chat completions (`/openai/v1/chat/completions`).
 * Each request gets one outcome, drawn from `Faults`: a normal answer, or one of the failure modes below.
 */
import { generateKeyPairSync, type KeyObject, verify } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export interface Faults {
  /** HTTP 429 with a short text body. */
  readonly status429: number;
  /** HTTP 500 with a short text body. */
  readonly status500: number;
  /** HTTP 200 whose JSON body is `{"error": {...}}` (OpenRouter style), code 429, 500 or 400. */
  readonly errorBody: number;
  /** HTTP 200 whose body is `{"error": {"code": 429, ...}}`: OpenRouter passing on an upstream rate limit. */
  readonly errorBody429: number;
  /** HTTP 200 with an empty body. */
  readonly empty: number;
  /** HTTP 200 with a body that is not JSON. */
  readonly malformed: number;
  /** HTTP 200 JSON with the wrong shape: no job_id, no pages, a judge reply that skips a parse or scores 11. */
  readonly badShape: number;
  /** A normal answer after 5 to 40 seconds. */
  readonly slow: number;
  /** Never answers; the socket stays open until the client gives up. */
  readonly hang: number;
  /** Destroys the socket without a response. */
  readonly drop: number;
  /** Reducto poll only: the job reports `Failed`. */
  readonly jobFailed: number;
  /** Reducto submit only: the job never completes (the workflow polls until its 30 minute budget ends). */
  readonly jobStuck: number;
  /** Judge on the primary model only: HTTP 429 `rate_limit_exceeded`. The judge should fall back to the next model. */
  readonly rateLimitPrimary?: number;
  /** Judge, any model: HTTP 429 `insufficient_quota`. The judge should fail the page without a fallback. */
  readonly insufficientQuota?: number;
  /** Token exchange: HTTP 401 (bad certificate or mapping, not retryable). */
  readonly token401?: number;
  /** Token exchange: HTTP 503 (retryable). */
  readonly token503?: number;
  /** `expires_in` of a fake token. 60 or less makes the judge exchange a token on every call (it renews 1 minute early). */
  readonly tokenTtl?: number;
  /** Only routes whose name starts with this get faults, for example "judge". */
  readonly only?: string;
}

export const NO_FAULTS: Faults = {
  status429: 0,
  status500: 0,
  errorBody: 0,
  errorBody429: 0,
  empty: 0,
  malformed: 0,
  badShape: 0,
  slow: 0,
  hang: 0,
  drop: 0,
  jobFailed: 0,
  jobStuck: 0,
};

/** JUDGE_MODEL, then JUDGE_FALLBACK_MODELS, as in stress/wrangler.jsonc. */
export const JUDGE_MODELS = ["stress-primary", "stress-fallback-1", "stress-fallback-2"];

type Outcome = "ok" | Exclude<keyof Faults, "jobFailed" | "jobStuck" | "only" | "tokenTtl">;

const HTTP_FAULTS: ReadonlyArray<Exclude<Outcome, "ok">> = [
  "status429",
  "status500",
  "errorBody",
  "errorBody429",
  "empty",
  "malformed",
  "badShape",
  "slow",
  "hang",
  "drop",
];

const WORDS =
  "invoice total amount due net payment terms account statement balance period revenue schedule table quarter tax".split(" ");

const sentence = (n: number) => Array.from({ length: n }, () => WORDS[Math.floor(Math.random() * WORDS.length)]).join(" ");

const markdown = () =>
  `# ${sentence(3)}\n\n${sentence(40)}\n\n| Item | Amount |\n| --- | --- |\n| ${sentence(2)} | ${(Math.random() * 1000).toFixed(2)} |\n`;

const readBody = (request: IncomingMessage) =>
  new Promise<string>((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", reject);
  });

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
};

interface Job {
  readonly readyAt: number;
  readonly fail: boolean;
}

export interface FakeServer {
  readonly url: string;
  /** Counts per `route outcome`, e.g. `judge status429`. */
  readonly stats: Map<string, number>;
  /** Private P-256 JWK (JSON) for `OPENAI_SIGNING_KEY`. The token route checks subject JWTs against its public half. */
  readonly signingKey: string;
  setFaults(faults: Faults): void;
  close(): Promise<void>;
}

/** Why an OpenAI token-exchange request is invalid, or undefined if its subject JWT is signed by `key` and unexpired. */
const badTokenRequest = (body: string, key: KeyObject): string | undefined => {
  const { grant_type, subject_token } = JSON.parse(body) as { grant_type?: string; subject_token?: string };
  const [header, claims, signature] = (subject_token ?? "").split(".");
  if (grant_type !== "urn:ietf:params:oauth:grant-type:token-exchange" || signature === undefined)
    return "not a token exchange with a JWT";
  const signed = Buffer.from(`${header}.${claims}`);
  if (!verify("sha256", signed, { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"))) return "bad signature";
  const { exp } = JSON.parse(Buffer.from(claims ?? "", "base64url").toString()) as { exp?: number };
  return (exp ?? 0) * 1000 < Date.now() ? "expired JWT" : undefined;
};

export const startFake = (port: number, initial: Faults): Promise<FakeServer> => {
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const signingKey = JSON.stringify({ ...keys.privateKey.export({ format: "jwk" }), kid: "stress" });
  let faults = initial;
  const stats = new Map<string, number>();
  const jobs = new Map<string, Job>();
  const hung = new Set<ServerResponse>();
  const count = (key: string) => stats.set(key, (stats.get(key) ?? 0) + 1);

  const draw = (route: string): Outcome => {
    if (faults.only !== undefined && !route.startsWith(faults.only)) return "ok";
    let r = Math.random();
    for (const fault of HTTP_FAULTS) {
      r -= faults[fault];
      if (r < 0) return fault;
    }
    return "ok";
  };

  const modelOf = (body: string) => /"model"\s*:\s*"([^"]*)"/.exec(body)?.[1] ?? "?";

  /** The OpenAI-specific faults, drawn before the generic HTTP faults. */
  const drawJudgeOrToken = (route: string, body: string): Outcome | undefined => {
    const r = Math.random();
    if (route === "token") {
      if (r < (faults.token401 ?? 0)) return "token401";
      if (r < (faults.token401 ?? 0) + (faults.token503 ?? 0)) return "token503";
      return "ok";
    }
    if (route !== "judge") return undefined;
    if (r < (faults.insufficientQuota ?? 0)) return "insufficientQuota";
    if (modelOf(body) === JUDGE_MODELS[0] && Math.random() < (faults.rateLimitPrimary ?? 0)) return "rateLimitPrimary";
    return undefined;
  };

  /** The good answer for a route, or the wrong-shape answer when `bad`. */
  const answer = (route: string, body: string, bad: boolean): unknown => {
    const parsed = (() => {
      try {
        return JSON.parse(body) as Record<string, unknown>;
      } catch {
        return {};
      }
    })();
    if (route === "reducto.submit") {
      if (bad) return { status: "Pending" };
      const id = crypto.randomUUID();
      const stuck = Math.random() < faults.jobStuck;
      jobs.set(id, {
        readyAt: stuck ? Number.POSITIVE_INFINITY : Date.now() + 500 + Math.random() * 5000,
        fail: Math.random() < faults.jobFailed,
      });
      return { job_id: id };
    }
    if (route.startsWith("reducto.poll ")) {
      const job = jobs.get(route.slice("reducto.poll ".length));
      if (job === undefined) return { status: "Failed", reason: "unknown job" };
      if (Date.now() < job.readyAt) return { status: "Pending" };
      if (job.fail) return { status: "Failed", reason: "stress: injected job failure" };
      if (bad)
        return { status: "Completed", result: { result: { type: "url", url: "https://platform.reducto.ai/result/expired" } } };
      return {
        status: "Completed",
        result: { result: { type: "full", chunks: [{ content: markdown() }] }, usage: { credits: 1 } },
      };
    }
    if (route === "mistral.ocr") return bad ? { pages: "none" } : { pages: [{ markdown: markdown() }] };
    if (route === "openrouter.key") return { data: { usage: 0, limit: null } };
    if (route === "token") return { access_token: "x", expires_in: faults.tokenTtl ?? 3600 };
    if (route === "judge") {
      const format = parsed.response_format as
        | {
            json_schema?: {
              schema?: { properties?: { evaluations?: { items?: { properties?: { label?: { enum?: Array<string> } } } } } };
            };
          }
        | undefined;
      const labels = format?.json_schema?.schema?.properties?.evaluations?.items?.properties?.label?.enum ?? [];
      const evaluations = labels.map((label) => ({
        label,
        errors:
          Math.random() < 0.5 ? [{ category: "text_corruption", severity: "high", description: `${label} misreads a word` }] : [],
        reasoning: `${label} is ${sentence(6)}`,
        score: 1 + Math.floor(Math.random() * 10),
      }));
      if (bad && evaluations.length > 0) {
        if (Math.random() < 0.5) evaluations.pop();
        else (evaluations[0] as { score: number }).score = 11;
      }
      return { choices: [{ message: { content: JSON.stringify({ evaluations }) } }], usage: { cost: 0.001 } };
    }
    // Small model: page note, error locations, run title.
    const text = bad ? "two\nlines" : route === "small.locate" ? '{"errors": []}' : "Reducto did best and Mistral did worst.";
    return { choices: [{ message: { content: text } }], usage: { cost: 0.0001 } };
  };

  const routeOf = (method: string, path: string, body: string): string | undefined => {
    if (method === "POST" && path === "/platform.reducto.ai/parse_async") return "reducto.submit";
    const job = /^\/platform\.reducto\.ai\/job\/(.+)$/.exec(path);
    if (method === "GET" && job?.[1] !== undefined) return `reducto.poll ${job[1]}`;
    if (method === "GET" && path === "/platform.reducto.ai/result/expired") return "reducto.expired";
    if (method === "POST" && path === "/api.mistral.ai/v1/ocr") return "mistral.ocr";
    if (method === "GET" && path === "/openrouter/key") return "openrouter.key";
    if (method === "POST" && path === "/oauth/token") return "token";
    if (method === "POST" && path === "/openai/v1/chat/completions") return "judge";
    if (method === "POST" && path === "/openrouter/chat/completions") {
      if (body.includes('"response_format"')) return "judge";
      return body.includes("excerpt") ? "small.locate" : "small";
    }
    return undefined;
  };

  const handle = async (request: IncomingMessage, response: ServerResponse) => {
    const body = await readBody(request);
    const path = new URL(request.url ?? "/", "http://fake").pathname;
    const route = routeOf(request.method ?? "GET", path, body);
    if (route === undefined) {
      count(`unknown ${request.method} ${path}`);
      return json(response, 404, { error: "no such fake route" });
    }
    const name = route.startsWith("reducto.poll") ? "reducto.poll" : route;
    const outcome = drawJudgeOrToken(name, body) ?? draw(name);
    if (name === "token" && outcome === "ok") {
      const problem = badTokenRequest(body, keys.publicKey);
      if (problem !== undefined) {
        count(`token invalid: ${problem}`);
        return json(response, 401, { error: "invalid_grant", error_description: problem });
      }
    }
    count(`${name} ${outcome}`);
    if (name === "judge") count(`judge model ${modelOf(body)} ${outcome}`);
    switch (outcome) {
      case "status429":
        response.writeHead(429, { "content-type": "text/plain" });
        return response.end("rate limited (stress)");
      case "status500":
        response.writeHead(500, { "content-type": "text/plain" });
        return response.end("internal error (stress)");
      case "errorBody": {
        const code = [429, 500, 400][Math.floor(Math.random() * 3)];
        return json(response, 200, { error: { code, message: `stress upstream error ${code}` } });
      }
      case "rateLimitPrimary":
        return json(response, 429, {
          error: { message: "Rate limit reached for requests (stress)", type: "requests", code: "rate_limit_exceeded" },
        });
      case "insufficientQuota":
        return json(response, 429, {
          error: { message: "You exceeded your current quota (stress)", type: "insufficient_quota", code: "insufficient_quota" },
        });
      case "token401":
        return json(response, 401, { error: "invalid_client", error_description: "certificate not trusted (stress)" });
      case "token503":
        response.writeHead(503, { "content-type": "text/plain" });
        return response.end("service unavailable (stress)");
      case "errorBody429":
        return json(response, 200, { error: { code: 429, message: "Rate limit exceeded (stress)" } });
      case "empty":
        response.writeHead(200, { "content-type": "application/json" });
        return response.end();
      case "malformed":
        response.writeHead(200, { "content-type": "application/json" });
        return response.end('{"choices": [ {"message": ');
      case "hang":
        hung.add(response);
        response.on("close", () => hung.delete(response));
        return;
      case "drop":
        return request.socket.destroy();
      case "slow":
        await new Promise((resolve) => setTimeout(resolve, 5000 + Math.random() * 35_000));
        return json(response, 200, answer(route, body, false));
      case "badShape":
        return json(response, 200, answer(route, body, true));
      case "ok":
        return json(response, 200, answer(route, body, false));
    }
  };

  const server: Server = createServer((request, response) => {
    handle(request, response).catch((error: unknown) => {
      count("fake internal error");
      console.error("fake server error", error);
      if (!response.headersSent) json(response, 500, { error: String(error) });
    });
  });
  server.keepAliveTimeout = 0;
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () =>
      resolve({
        url: `http://127.0.0.1:${port}`,
        signingKey,
        stats,
        setFaults: (next) => {
          faults = next;
        },
        close: () =>
          new Promise<void>((done) => {
            for (const response of hung) response.socket?.destroy();
            server.closeAllConnections();
            server.close(() => done());
          }),
      }),
    );
  });
};
