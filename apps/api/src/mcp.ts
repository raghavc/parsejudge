import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { DEFAULT_PRESET_IDS, PRESETS, PROVIDERS } from "@parsejudge/core";
import * as z from "zod";
import { handler } from "./api.ts";
import type { Env } from "./env.ts";
import { INTERNAL_HEADER, internalHeader } from "./internal.ts";
import { type AgentProps, listAgents, revokeAgents } from "./oauth.ts";
import { signedUploadUrl } from "./uploads.ts";

const MAX_FETCH_BYTES = 100 * 1024 * 1024;

const INSTRUCTIONS = `ParseJudge compares document parsers on your documents. A blind judge model scores each parser's output on every page.

To evaluate local files:
1. Call create_upload_url. Upload the files with the curl command it returns: one command uploads many files in parallel, and every file goes into the same upload.
   Files on the web: call upload_from_url instead.
2. Call start_run with the uploadId. It runs every file the upload received; list_uploaded_files shows them first. Leave presetIds out to run the default hosted parsers (free).
   Parsers that are not hosted need your own key: pass it in credentials (see list_providers for the key names).
3. Call get_run until status is "succeeded" or "failed". The run's owner also gets an email when it finishes, unless they turned that off.
4. Read the results with get_run (summary), list_pages and get_page. Share the reportUrl.`;

type Json = Record<string, unknown>;

class ApiError extends Error {}

const describeStatus = (status: number) =>
  status === 404
    ? "Not found, or you can't open it."
    : status === 401
      ? "Your account no longer exists, or this connection was revoked."
      : status === 400
        ? "The request was rejected. Check the ids, that the documents are yours and not deleted, and the 1,000-page limit per run."
        : `ParseJudge returned HTTP ${status}.`;

const ok = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }] });
const fail = (message: string) => ({ isError: true, content: [{ type: "text" as const, text: message }] });

const tool =
  <A>(run: (args: A) => Promise<unknown>) =>
  async (args: A) => {
    try {
      return ok(await run(args));
    } catch (error) {
      if (error instanceof ApiError) return fail(error.message);
      throw error;
    }
  };

const buildServer = (env: Env, userId: string, oauth: OAuthHelpers) => {
  const base = env.PUBLIC_URL.replace(/\/+$/, "");
  const call = async (method: string, path: string, body?: unknown): Promise<Json | null> => {
    const headers = new Headers({ [INTERNAL_HEADER]: internalHeader(userId) });
    let payload: BodyInit | null = null;
    if (body instanceof ArrayBuffer) {
      payload = body;
      headers.set("content-type", "application/octet-stream");
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      headers.set("content-type", "application/json");
    }
    const response = await handler(new Request(`${base}${path}`, { method, headers, body: payload }));
    if (!response.ok) throw new ApiError(describeStatus(response.status));
    return response.status === 204 ? null : ((await response.json()) as Json);
  };
  const reportUrl = (shareId: unknown) => `${base}/r/${String(shareId)}`;

  /** A run by id, share id, or report URL. */
  const findRun = async (ref: string): Promise<Json> => {
    const key = /\/r\/([^/?#]+)/.exec(ref)?.[1] ?? ref.trim();
    try {
      return (await call("GET", `/v1/runs/${encodeURIComponent(key)}`)) ?? {};
    } catch {
      return (await call("GET", `/v1/share/${encodeURIComponent(key)}`)) ?? {};
    }
  };

  const server = new McpServer({ name: "parsejudge", version: "1.0.0" }, { instructions: INSTRUCTIONS });
  const read = { readOnlyHint: true, openWorldHint: false };
  const runRef = z.string().describe("Run id, share id, or report URL (https://parsejudge.com/r/...)");

  server.registerTool(
    "list_providers",
    {
      description:
        "Parser presets you can run. hosted=true runs free on ParseJudge's keys; the others need your own key, passed to start_run as credentials[provider][key] for each name in credentialKeys. default=true is in the default set.",
      annotations: read,
    },
    tool(async () =>
      PRESETS.map((preset) => ({
        id: preset.id,
        provider: preset.provider,
        label: preset.label,
        mode: preset.mode,
        listPriceUsdPer1kPages: Math.round(preset.listPriceUsdPerPage * 1000 * 100) / 100,
        hosted: preset.hosted,
        default: DEFAULT_PRESET_IDS.includes(preset.id),
        credentialKeys: preset.hosted ? [] : PROVIDERS[preset.provider].credentialKeys,
      })),
    ),
  );

  server.registerTool(
    "create_upload_url",
    {
      description:
        "A URL for uploading local files, valid for 1 hour and for any number of files. PUT each file's raw bytes to <url>/<file name>; the response has the commands. Files can go up in parallel. Accepts PDF, images, DOCX, PPTX and XLSX. Every file is tagged with the uploadId: pass it to start_run to run all of them, without tracking document ids.",
    },
    tool(async () => {
      const { url, uploadId, expiresAt } = await signedUploadUrl(env, userId);
      return {
        uploadId,
        url: `${url}/`,
        method: "PUT",
        expiresAt: new Date(expiresAt).toISOString(),
        uploadFiles: `curl -sS --fail-with-body --parallel --parallel-max 16 -T "{a.pdf,b.docx}" "${url}/"`,
        uploadFolder: `find ./docs -type f -print0 | xargs -0 -P 16 -I{} curl -sS --fail-with-body -T {} "${url}/"`,
        notes:
          'curl -T with a URL ending in "/" adds the file name to the URL. Each response is {documentId, pageCount}, or {filename, error} for a file that could not be read.',
        next: `Call start_run with uploadId "${uploadId}".`,
      };
    }),
  );

  server.registerTool(
    "list_uploaded_files",
    {
      description: "The files an upload URL from create_upload_url has received so far, oldest first.",
      inputSchema: { uploadId: z.string() },
      annotations: read,
    },
    tool(async ({ uploadId }: { uploadId: string }) => {
      const files = ((await call("GET", `/v1/documents?upload=${encodeURIComponent(uploadId)}`)) ?? []) as unknown as Array<{
        pageCount: number;
      }>;
      return { uploadId, files: files.length, pages: files.reduce((n, f) => n + f.pageCount, 0), documents: files };
    }),
  );

  server.registerTool(
    "upload_from_url",
    {
      description:
        "Download a document from a public http(s) URL into your account. Returns {documentId, pageCount} for start_run.",
      inputSchema: {
        url: z.string().url(),
        filename: z.string().optional().describe("Name to show in reports. Defaults to the last part of the URL path."),
      },
    },
    tool(async ({ url, filename }: { url: string; filename?: string | undefined }) => {
      const source = new URL(url);
      if (source.protocol !== "https:" && source.protocol !== "http:") throw new ApiError("Only http and https URLs work.");
      const response = await fetch(source, { redirect: "follow" });
      if (!response.ok) throw new ApiError(`Downloading the file returned HTTP ${response.status}.`);
      if (Number(response.headers.get("content-length") ?? 0) > MAX_FETCH_BYTES) throw new ApiError("The file is over 100 MB.");
      const bytes = await response.arrayBuffer();
      if (bytes.byteLength > MAX_FETCH_BYTES) throw new ApiError("The file is over 100 MB.");
      const name = filename ?? (decodeURIComponent(source.pathname.split("/").pop() ?? "") || "document");
      return call("POST", `/v1/documents?filename=${encodeURIComponent(name)}`, bytes);
    }),
  );

  server.registerTool(
    "suggest_title",
    {
      description: "A short run title from file names, the same one the app suggests.",
      inputSchema: { filenames: z.array(z.string()).min(1) },
      annotations: read,
    },
    tool(({ filenames }: { filenames: Array<string> }) => call("POST", "/v1/titles", { filenames })),
  );

  const credentials = z
    .record(z.string(), z.record(z.string(), z.string()))
    .optional()
    .describe(
      'Your own keys by provider, e.g. {"llamaparse": {"LLAMA_CLOUD_API_KEY": "llx-..."}}. Stored encrypted with this run only.',
    );

  const uploadedIds = async (uploadId: string) => {
    const files = ((await call("GET", `/v1/documents?upload=${encodeURIComponent(uploadId)}`)) ?? []) as unknown as Array<{
      documentId: string;
    }>;
    if (files.length === 0) throw new ApiError(`Upload ${uploadId} has no files yet.`);
    return files.map((f) => f.documentId);
  };

  const startRun = async (args: {
    documentIds: ReadonlyArray<string>;
    presetIds?: ReadonlyArray<string> | undefined;
    title?: string | undefined;
    credentials?: Record<string, Record<string, string>> | undefined;
  }) => {
    for (const id of args.presetIds ?? []) {
      const preset = PRESETS.find((p) => p.id === id);
      if (preset === undefined) throw new ApiError(`Unknown preset ${id}. Call list_providers for the ids.`);
      if (preset.hosted) continue;
      const missing = PROVIDERS[preset.provider].credentialKeys.filter((key) => !args.credentials?.[preset.provider]?.[key]);
      if (missing.length > 0) throw new ApiError(`${preset.label} needs credentials.${preset.provider}: ${missing.join(", ")}.`);
    }
    const created = await call("POST", "/v1/runs", {
      documentIds: args.documentIds,
      ...(args.presetIds === undefined ? {} : { presetIds: args.presetIds }),
      ...(args.title === undefined ? {} : { title: args.title }),
      credentials: args.credentials ?? {},
    });
    return { ...created, reportUrl: reportUrl(created?.shareId), next: "Call get_run with the runId to follow progress." };
  };

  server.registerTool(
    "start_run",
    {
      description:
        "Start an evaluation. Pass uploadId to run every file sent to that upload URL, or documentIds, or both. Up to 1,000 pages per run. Without presetIds it runs the default hosted parsers. Returns runId and the report URL.",
      inputSchema: {
        uploadId: z.string().optional().describe("From create_upload_url: runs every file that upload received."),
        documentIds: z.array(z.string()).optional().describe("From upload_from_url or earlier uploads."),
        presetIds: z.array(z.string()).min(1).optional().describe("Preset ids from list_providers."),
        title: z.string().max(80).optional().describe("Run title. Without one, a title is made from the file names."),
        credentials,
      },
    },
    tool(
      async ({
        uploadId,
        documentIds,
        ...rest
      }: Omit<Parameters<typeof startRun>[0], "documentIds"> & {
        uploadId?: string | undefined;
        documentIds?: Array<string> | undefined;
      }) => {
        const ids = [...new Set([...(uploadId === undefined ? [] : await uploadedIds(uploadId)), ...(documentIds ?? [])])];
        if (ids.length === 0) throw new ApiError("Pass uploadId or documentIds.");
        return startRun({ ...rest, documentIds: ids });
      },
    ),
  );

  server.registerTool(
    "run_again",
    {
      description:
        "Start a new run on the same documents as an earlier run of yours. Uses the earlier run's hosted parsers unless you pass presetIds (and credentials for any that aren't hosted).",
      inputSchema: { run: runRef, presetIds: z.array(z.string()).min(1).optional(), credentials },
    },
    tool(
      async (args: {
        run: string;
        presetIds?: Array<string> | undefined;
        credentials?: Record<string, Record<string, string>> | undefined;
      }) => {
        const run = await findRun(args.run);
        if (run.owned !== true) throw new ApiError("You can only run your own runs again.");
        if (run.dataDeletedAt !== null) throw new ApiError("This run's documents were deleted.");
        const hosted = (run.presetIds as Array<string>).filter((id) => PRESETS.find((p) => p.id === id)?.hosted);
        return startRun({
          documentIds: (run.documents as Array<{ id: string }>).map((d) => d.id),
          presetIds: args.presetIds ?? hosted,
          title: (run.title as string | null) ?? undefined,
          credentials: args.credentials,
        });
      },
    ),
  );

  server.registerTool(
    "list_runs",
    {
      description: "Your runs, newest first, with status, progress, top preset and who can open the report.",
      inputSchema: { search: z.string().optional().describe("Only runs whose title contains this text.") },
      annotations: read,
    },
    tool(async ({ search }: { search?: string | undefined }) => {
      const rows = ((await call("GET", "/v1/runs")) ?? []) as unknown as Array<Json>;
      return rows
        .filter(
          (row) =>
            search === undefined ||
            String(row.title ?? "")
              .toLowerCase()
              .includes(search.toLowerCase()),
        )
        .map((row) => ({ ...row, reportUrl: reportUrl(row.shareId) }));
    }),
  );

  server.registerTool(
    "get_run",
    {
      description:
        "A run's status, progress, documents and, once it succeeded, the summary: per preset mean and median score (0-10), high-severity error rate, error counts, failed pages, list price, observed cost, latency, head-to-head wins/ties/losses and the price-accuracy Pareto frontier. Works for your runs and for reports shared by link.",
      inputSchema: { run: runRef },
      annotations: read,
    },
    tool(async ({ run: ref }: { run: string }) => {
      const run = await findRun(ref);
      const documents = run.documents as Array<{ id: string; filename: string; pages: Array<unknown> }>;
      const scores = run.scores as Array<{ status: string }>;
      const pages = documents.reduce((n, d) => n + d.pages.length, 0);
      return {
        id: run.owned === true ? run.id : undefined,
        shareId: run.shareId,
        reportUrl: reportUrl(run.shareId),
        title: run.title,
        status: run.status,
        error: run.error,
        owned: run.owned,
        visibility: run.visibility,
        presetIds: run.presetIds,
        judge: { version: run.judgeVersion, model: run.judgeModel },
        documents: documents.map((d) => ({ id: d.id, filename: d.filename, pages: d.pages.length })),
        progress: { pages, parsesDone: scores.length, parsesTotal: pages * (run.presetIds as Array<string>).length },
        summary: run.summary,
        createdAt: run.createdAt,
        completedAt: run.completedAt,
        dataDeletedAt: run.dataDeletedAt,
      };
    }),
  );

  server.registerTool(
    "list_pages",
    {
      description:
        "Pages of a run with each preset's score and high-severity error count, the gap between best and worst score, and a one-sentence note on how the parsers differ (flagged pages only). Use get_page for the outputs and the judge's errors.",
      inputSchema: {
        run: runRef,
        filter: z
          .enum(["all", "flagged", "high"])
          .default("all")
          .describe("flagged: pages with a note. high: any high-severity error."),
        sort: z.enum(["document", "gap"]).default("document"),
        limit: z.number().int().min(1).max(1000).default(200),
      },
      annotations: read,
    },
    tool(async (args: { run: string; filter: "all" | "flagged" | "high"; sort: "document" | "gap"; limit: number }) => {
      const run = await findRun(args.run);
      const scores = run.scores as Array<{
        pageId: string;
        presetId: string;
        status: string;
        score: number | null;
        high: number;
      }>;
      const byPage = new Map<string, typeof scores>();
      for (const s of scores) byPage.set(s.pageId, [...(byPage.get(s.pageId) ?? []), s]);
      const documents = run.documents as Array<{
        filename: string;
        pages: Array<{ id: string; index: number; note: string | null }>;
      }>;
      const pages = documents.flatMap((d) =>
        d.pages.map((page) => {
          const parses = byPage.get(page.id) ?? [];
          const scored = parses.flatMap((p) => (p.score === null ? [] : [p.score]));
          return {
            pageId: page.id,
            document: d.filename,
            page: page.index + 1,
            note: page.note,
            gap: scored.length > 1 ? Math.max(...scored) - Math.min(...scored) : null,
            scores: Object.fromEntries(parses.map((p) => [p.presetId, { status: p.status, score: p.score, high: p.high }])),
            url: `${reportUrl(run.shareId)}/p/${page.id}`,
          };
        }),
      );
      const kept = pages.filter((p) =>
        args.filter === "flagged"
          ? p.note !== null
          : args.filter === "high"
            ? Object.values(p.scores).some((s) => s.high > 0)
            : true,
      );
      if (args.sort === "gap") kept.sort((a, b) => (b.gap ?? -1) - (a.gap ?? -1));
      return { total: kept.length, pages: kept.slice(0, args.limit) };
    }),
  );

  server.registerTool(
    "get_page",
    {
      description:
        "One page of a run: the page image URL (expires in 1 hour), and for each preset its status, latency, Markdown output, judge score, reasoning and errors (category, severity, description, and the excerpts of the output each error is about).",
      inputSchema: {
        run: runRef,
        pageId: z.string(),
        presetIds: z.array(z.string()).optional().describe("Only these presets."),
        includeMarkdown: z.boolean().default(true),
      },
      annotations: read,
    },
    tool(async (args: { run: string; pageId: string; presetIds?: Array<string> | undefined; includeMarkdown: boolean }) => {
      const run = await findRun(args.run);
      const page = await call("GET", `/v1/runs/${encodeURIComponent(String(run.id))}/pages/${encodeURIComponent(args.pageId)}`);
      const parses = ((page?.parses ?? []) as Array<Json>)
        .filter((p) => args.presetIds === undefined || args.presetIds.includes(String(p.presetId)))
        .map((p) => (args.includeMarkdown ? p : { ...p, markdown: undefined }));
      return { ...page, parses, url: `${reportUrl(run.shareId)}/p/${args.pageId}` };
    }),
  );

  server.registerTool(
    "rename_run",
    { description: "Rename one of your runs.", inputSchema: { runId: z.string(), title: z.string().min(1).max(80) } },
    tool(async ({ runId, title }: { runId: string; title: string }) => {
      await call("PATCH", `/v1/runs/${encodeURIComponent(runId)}`, { title });
      return { runId, title };
    }),
  );

  server.registerTool(
    "set_sharing",
    {
      description: 'Who can open a run\'s report: "link" (anyone with the report URL, no sign-in) or "private" (only you).',
      inputSchema: { runId: z.string(), visibility: z.enum(["link", "private"]) },
    },
    tool(async ({ runId, visibility }: { runId: string; visibility: "link" | "private" }) => {
      await call("PATCH", `/v1/runs/${encodeURIComponent(runId)}`, { visibility });
      return { runId, visibility };
    }),
  );

  server.registerTool(
    "rotate_share_link",
    {
      description: "Give a run a new report URL. The old URL stops working.",
      inputSchema: { runId: z.string() },
      annotations: { destructiveHint: true },
    },
    tool(async ({ runId }: { runId: string }) => {
      const rotated = await call("POST", `/v1/runs/${encodeURIComponent(runId)}/share-link`);
      return { runId, shareId: rotated?.shareId, reportUrl: reportUrl(rotated?.shareId) };
    }),
  );

  server.registerTool(
    "delete_run",
    {
      description:
        'Delete one of your runs. scope "data" deletes the documents, page images and parser outputs and keeps the summary; "report" deletes the report too. A run in progress is stopped first. Cannot be undone.',
      inputSchema: { runId: z.string(), scope: z.enum(["data", "report"]) },
      annotations: { destructiveHint: true },
    },
    tool(async ({ runId, scope }: { runId: string; scope: "data" | "report" }) => {
      await call("DELETE", `/v1/runs/${encodeURIComponent(runId)}?scope=${scope}`);
      return { runId, deleted: scope };
    }),
  );

  server.registerTool(
    "get_account",
    { description: "Your email and whether you get an email when a run finishes.", annotations: read },
    tool(() => call("GET", "/v1/account")),
  );

  server.registerTool(
    "update_account",
    {
      description: "Turn the email sent when a run finishes on or off.",
      inputSchema: { notifyOnDone: z.boolean() },
    },
    tool(({ notifyOnDone }: { notifyOnDone: boolean }) => call("PATCH", "/v1/account", { notifyOnDone })),
  );

  server.registerTool(
    "list_connected_agents",
    { description: "Apps and agents connected to your account, including this one.", annotations: read },
    tool(() => listAgents(oauth, userId)),
  );

  server.registerTool(
    "disconnect_agent",
    {
      description: "Revoke a connected agent's access. Disconnecting this agent ends this connection.",
      inputSchema: { agentId: z.string().describe("id from list_connected_agents") },
      annotations: { destructiveHint: true },
    },
    tool(async ({ agentId }: { agentId: string }) => {
      await oauth.revokeGrant(agentId, userId);
      return { disconnected: agentId };
    }),
  );

  server.registerTool(
    "delete_all_data",
    {
      description:
        'Delete your account and everything in it: all runs (in-progress runs are stopped first), documents, reports and share links, and disconnect every agent. Cannot be undone. Pass confirm: "delete my data".',
      inputSchema: { confirm: z.literal("delete my data") },
      annotations: { destructiveHint: true },
    },
    tool(async () => {
      await call("DELETE", "/v1/account");
      await revokeAgents(oauth, userId);
      return { deleted: true };
    }),
  );

  return server;
};

/** The MCP endpoint (Streamable HTTP, stateless). OAuthProvider has already checked the token. */
export const mcpHandler = (oauth: (env: Env) => OAuthHelpers) => ({
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const { userId } = ctx.props as AgentProps;
    const server = buildServer(env, userId, oauth(env));
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    return transport.handleRequest(request);
  },
});
