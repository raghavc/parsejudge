/**
 * Adversarial stress harness. Local only: runs `wrangler dev` with stress/wrangler.jsonc against the fake
 * provider and judge server in fake.ts, uploads generated PDFs, starts runs and checks that every run ends.
 *
 *   pnpm --filter @parsejudge/api stress <scenario>     scenarios: see SCENARIOS below
 *
 * Pass: every run reaches `succeeded` or `failed` before the deadline, and every (page, preset) has a parse row
 * (succeeded or failed). A page with a succeeded parse must also have verdicts or a judge_failures row.
 * Output: .wrangler/stress/<scenario>-<time>/ (outside stress/ so wrangler does not reload on writes): report.json, wrangler.log, and a summary on stdout.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { deserialize } from "node:v8";
import { type Faults, NO_FAULTS, startFake } from "./fake.ts";
import { makePdf } from "./pdf.ts";

interface Scenario {
  readonly runs: number;
  readonly docsPerRun: number;
  readonly pagesPerDoc: number;
  readonly presets: ReadonlyArray<string>;
  readonly faults: Faults;
  /** Share of page instances that `createBatch` drops (see worker.ts). */
  readonly batchDrop?: number;
  /** "once": an error entry on one call only. "always": an error entry on every retry. "lost": no error entry. */
  readonly batchMode?: "once" | "always" | "lost";
  /** Step faults, "<share>:<step name regex>" (see steps.ts). */
  readonly stepFail?: string;
  /** Kill wrangler with SIGKILL at these seconds after the runs start, and start it again 5 s later. */
  readonly kills?: ReadonlyArray<number>;
  /** Press Continue (`POST /v1/runs/:id/continue`) once on a run that is not terminal and has not changed for this long. */
  readonly continueWhenIdleSeconds?: number;
  /** Also press Continue once on a run that failed (a run whose run workflow errored is marked failed when read). */
  readonly continueFailed?: boolean;
  readonly deadlineMinutes: number;
}

const MIXED: Faults = {
  ...NO_FAULTS,
  status429: 0.05,
  status500: 0.03,
  errorBody: 0.03,
  empty: 0.02,
  malformed: 0.02,
  badShape: 0.02,
  slow: 0.02,
  hang: 0.002,
  drop: 0.02,
  jobFailed: 0.02,
};

const PRESETS = ["reducto_r1", "reducto_r1_mini", "mistral_ocr_4_1"];

const SCENARIOS: Record<string, Scenario> = {
  /** Sanity check: no faults, one small run. */
  smoke: { runs: 1, docsPerRun: 1, pagesPerDoc: 3, presets: PRESETS, faults: NO_FAULTS, deadlineMinutes: 5 },
  /** One large run: 4 documents of 100 pages, every fault mode. */
  large: { runs: 1, docsPerRun: 4, pagesPerDoc: 100, presets: PRESETS, faults: MIXED, deadlineMinutes: 45 },
  /** Many concurrent runs sharing the provider and judge slot pools. */
  concurrent: { runs: 12, docsPerRun: 2, pagesPerDoc: 10, presets: PRESETS, faults: MIXED, deadlineMinutes: 45 },
  /** createBatch fails 2% of page instances once, then succeeds on the step retry. */
  batch: { runs: 4, docsPerRun: 2, pagesPerDoc: 40, presets: PRESETS, faults: NO_FAULTS, batchDrop: 0.02, deadlineMinutes: 20 },
  /** createBatch returns error entries for the same 2% of page instances on every call. */
  "batch-persistent": {
    runs: 4,
    docsPerRun: 2,
    pagesPerDoc: 40,
    presets: PRESETS,
    faults: NO_FAULTS,
    batchDrop: 0.02,
    batchMode: "always",
    deadlineMinutes: 20,
  },
  /** wrangler is killed three times while runs are in flight. */
  restart: {
    runs: 4,
    docsPerRun: 2,
    pagesPerDoc: 20,
    presets: PRESETS,
    faults: MIXED,
    kills: [45, 120, 240],
    continueWhenIdleSeconds: 180,
    deadlineMinutes: 30,
  },
  /** createBatch silently loses 2% of page instances (no error entry); Continue must skip them and finish the run. */
  "continue-missing": {
    runs: 2,
    docsPerRun: 2,
    pagesPerDoc: 40,
    presets: PRESETS,
    faults: NO_FAULTS,
    batchDrop: 0.05,
    batchMode: "lost",
    continueWhenIdleSeconds: 60,
    deadlineMinutes: 15,
  },
  /** `summarize` and `record failure` always fail, so the RunWorkflow errors with the run still `running`; Continue must finish it. */
  "continue-errored": {
    runs: 2,
    docsPerRun: 1,
    pagesPerDoc: 10,
    presets: PRESETS,
    faults: NO_FAULTS,
    stepFail: "1:^(summarize|record failure)$",
    continueWhenIdleSeconds: 60,
    continueFailed: true,
    deadlineMinutes: 15,
  },
  /** Half of the judge calls get HTTP 200 `{"error": {"code": 429}}`; providers are clean. */
  "judge-429": {
    runs: 4,
    docsPerRun: 2,
    pagesPerDoc: 10,
    presets: PRESETS,
    faults: { ...NO_FAULTS, errorBody429: 0.5, only: "judge" },
    deadlineMinutes: 45,
  },
  /** 10% of the steps that record a failure or report progress fail as if D1 or the RunEvents DO were down. */
  // Every judge call on the primary model gets HTTP 429 rate_limit_exceeded: every page should be judged by a fallback.
  "judge-fallback": {
    runs: 4,
    docsPerRun: 2,
    pagesPerDoc: 10,
    presets: PRESETS,
    faults: { ...NO_FAULTS, rateLimitPrimary: 1 },
    deadlineMinutes: 20,
  },
  // HTTP 429 insufficient_quota: the page fails its judge step at once (no fallback model), and the run still finishes.
  "judge-quota": {
    runs: 4,
    docsPerRun: 2,
    pagesPerDoc: 10,
    presets: PRESETS,
    faults: { ...NO_FAULTS, insufficientQuota: 0.3 },
    deadlineMinutes: 20,
  },
  // Token exchange 401 (not retryable) and 503 (retryable), with a TTL that forces an exchange on every judge call.
  token: {
    runs: 4,
    docsPerRun: 2,
    pagesPerDoc: 10,
    presets: PRESETS,
    faults: { ...NO_FAULTS, token401: 0.1, token503: 0.3, tokenTtl: 300 },
    deadlineMinutes: 30,
  },
  steps: {
    runs: 4,
    docsPerRun: 2,
    pagesPerDoc: 20,
    presets: PRESETS,
    faults: MIXED,
    stepFail: "0.1:^(record|report|notify|summarize)",
    continueWhenIdleSeconds: 300,
    deadlineMinutes: 40,
  },
  /** Every call is slow, hangs or drops: tests step timeouts and the judge's long backoff. */
  hostile: {
    runs: 2,
    docsPerRun: 1,
    pagesPerDoc: 10,
    presets: PRESETS,
    faults: { ...NO_FAULTS, status429: 0.15, hang: 0.1, drop: 0.15, slow: 0.1, errorBody: 0.1, jobStuck: 0.05 },
    deadlineMinutes: 90,
  },
};

const API_PORT = Number(process.env.STRESS_API_PORT ?? 8787);
const FAKE_PORT = Number(process.env.STRESS_FAKE_PORT ?? 8790);
const API = `http://localhost:${API_PORT}`;
const USER = { "x-parsejudge-user": "stress@example.com" };
const API_DIR = join(import.meta.dirname, "..");

const name = process.argv[2] ?? "smoke";
const scenario = SCENARIOS[name];
if (scenario === undefined) {
  console.error(`Unknown scenario ${name}. Pick one of: ${Object.keys(SCENARIOS).join(", ")}`);
  process.exit(2);
}

const out = join(API_DIR, ".wrangler", "stress", `${name}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
const persist = join(out, "state");
mkdirSync(persist, { recursive: true });
const log = createWriteStream(join(out, "wrangler.log"));
const events: Array<{ at: number; event: string }> = [];
const startedAt = Date.now();
const note = (event: string) => {
  events.push({ at: Math.round((Date.now() - startedAt) / 1000), event });
  console.log(`[${Math.round((Date.now() - startedAt) / 1000)}s] ${event}`);
};

const wranglerArgs = (fakeUrl: string) => [
  "wrangler",
  "dev",
  "-c",
  "stress/wrangler.jsonc",
  "--persist-to",
  persist,
  "--port",
  String(API_PORT),
  "--ip",
  "127.0.0.1",
  "--var",
  `FAKE_URL:${fakeUrl}`,
  "--var",
  `JUDGE_BASE_URL:${fakeUrl}/openrouter`,
  "--var",
  `OPENAI_BASE_URL:${fakeUrl}/openai/v1`,
  "--var",
  `OPENAI_AUTH_URL:${fakeUrl}/oauth/token`,
  "--var",
  `STRESS_BATCH_DROP:${scenario.batchDrop ?? 0}`,
  "--var",
  `STRESS_BATCH_MODE:${scenario.batchMode ?? "once"}`,
  "--var",
  `STRESS_STEP_FAIL:${scenario.stepFail ?? ""}`,
  "--var",
  `PUBLIC_URL:${API}`,
  "--inspector-port",
  String(API_PORT + 1000),
];

let wrangler: ChildProcess | undefined;

const startWrangler = async (fakeUrl: string) => {
  wrangler = spawn("npx", wranglerArgs(fakeUrl), { cwd: API_DIR, env: { ...process.env, CI: "1" }, detached: true });
  wrangler.stdout?.pipe(log, { end: false });
  wrangler.stderr?.pipe(log, { end: false });
  for (let i = 0; i < 240; i++) {
    try {
      if ((await fetch(`${API}/v1/presets`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("wrangler dev did not start; see wrangler.log");
};

const killWrangler = async () => {
  const child = wrangler;
  if (child?.pid === undefined) return;
  // Kill the whole process group: npx, wrangler and workerd.
  process.kill(-child.pid, "SIGKILL");
  await new Promise((resolve) => child.once("exit", resolve));
  wrangler = undefined;
};

/** The local D1 file wrangler writes under --persist-to. */
const d1 = (): DatabaseSync => {
  const dir = join(persist, "v3", "d1", "miniflare-D1DatabaseObject");
  const file = readdirSync(dir)
    .filter((f) => f.endsWith(".sqlite"))
    .map((f) => join(dir, f))
    .sort((a, b) => statSync(b).size - statSync(a).size)[0];
  if (file === undefined) throw new Error("No local D1 database");
  return new DatabaseSync(file, { readOnly: true });
};

const post = async (path: string, body: BodyInit, contentType: string) => {
  const response = await fetch(`${API}${path}`, { method: "POST", headers: { ...USER, "content-type": contentType }, body });
  const text = await response.text();
  if (!response.ok) throw new Error(`POST ${path}: HTTP ${response.status} ${text.slice(0, 300)}`);
  return JSON.parse(text) as Record<string, unknown>;
};

/** Retries a client call while wrangler restarts. */
const withRetry = async <A>(call: () => Promise<A>): Promise<A> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      if (attempt >= 20) throw error;
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
};

interface RunCheck {
  readonly runId: string;
  readonly status: string;
  readonly error: string | null;
  readonly pages: number;
  readonly cellsExpected: number;
  readonly cellsRecorded: number;
  readonly cellsFailed: number;
  readonly pagesMissingParses: ReadonlyArray<string>;
  readonly pagesJudgedOrFailed: number;
  readonly pagesSilentlyUnjudged: ReadonlyArray<string>;
  readonly judgeFailures: number;
  readonly failureMessages: Record<string, number>;
  readonly judgeFailureMessages: Record<string, number>;
}

const shortMessage = (message: string) =>
  message
    .replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<id>")
    .replace(/\d+/g, "N")
    .slice(0, 120);

const tally = (messages: ReadonlyArray<string>) => {
  const counts: Record<string, number> = {};
  for (const m of messages) counts[shortMessage(m)] = (counts[shortMessage(m)] ?? 0) + 1;
  return counts;
};

const checkRun = (db: DatabaseSync, runId: string, presets: number): RunCheck => {
  const run = db.prepare("SELECT status, error FROM runs WHERE id = ?").get(runId) as { status: string; error: string | null };
  const pages = db
    .prepare("SELECT p.id FROM pages p JOIN run_documents rd ON rd.document_id = p.document_id WHERE rd.run_id = ?")
    .all(runId) as Array<{ id: string }>;
  const parses = db.prepare("SELECT page_id, status, error FROM parses WHERE run_id = ?").all(runId) as Array<{
    page_id: string;
    status: string;
    error: string | null;
  }>;
  const verdictPages = new Set(
    (db.prepare("SELECT DISTINCT page_id FROM verdicts WHERE run_id = ?").all(runId) as Array<{ page_id: string }>).map(
      (r) => r.page_id,
    ),
  );
  const judgeFailures = db.prepare("SELECT page_id, error FROM judge_failures WHERE run_id = ?").all(runId) as Array<{
    page_id: string;
    error: string;
  }>;
  const judgeFailed = new Set(judgeFailures.map((r) => r.page_id));
  const byPage = new Map<string, number>();
  for (const p of parses) byPage.set(p.page_id, (byPage.get(p.page_id) ?? 0) + 1);
  const succeededPages = new Set(parses.filter((p) => p.status === "succeeded").map((p) => p.page_id));
  return {
    runId,
    status: run.status,
    error: run.error,
    pages: pages.length,
    cellsExpected: pages.length * presets,
    cellsRecorded: parses.length,
    cellsFailed: parses.filter((p) => p.status === "failed").length,
    pagesMissingParses: pages.filter((p) => (byPage.get(p.id) ?? 0) < presets).map((p) => p.id),
    pagesJudgedOrFailed: pages.filter((p) => verdictPages.has(p.id) || judgeFailed.has(p.id)).length,
    pagesSilentlyUnjudged: [...succeededPages].filter((p) => !verdictPages.has(p) && !judgeFailed.has(p)),
    judgeFailures: judgeFailures.length,
    failureMessages: tally(parses.filter((p) => p.status === "failed").map((p) => p.error ?? "(no message)")),
    judgeFailureMessages: tally(judgeFailures.map((r) => r.error)),
  };
};

const STATUS = ["queued", "running", "paused", "errored", "terminated", "complete", "waitingForPause", "waiting"];
const EVENTS = [
  "WORKFLOW_QUEUED",
  "WORKFLOW_START",
  "WORKFLOW_SUCCESS",
  "WORKFLOW_FAILURE",
  "WORKFLOW_TERMINATED",
  "STEP_START",
  "STEP_SUCCESS",
  "STEP_FAILURE",
  "SLEEP_START",
  "SLEEP_COMPLETE",
  "ATTEMPT_START",
  "ATTEMPT_SUCCESS",
  "ATTEMPT_FAILURE",
  "INTERNAL",
  "WAIT_START",
  "WAIT_COMPLETE",
  "WAIT_TIMED_OUT",
];

interface Instance {
  readonly workflow: string;
  readonly id: string;
  readonly status: string;
  /** The last few engine log rows, newest first: event, step name and metadata. */
  readonly lastEvents: ReadonlyArray<string>;
}

/**
 * Every workflow instance in the local Workflows engine. Miniflare keeps one SQLite file per instance, with
 * V8-serialized `ENGINE_STATUS` and `INSTANCE_METADATA` in `_cf_KV` and the step log in `states`.
 */
const workflowInstances = (): Array<Instance> => {
  const root = join(persist, "v3", "workflows");
  const found: Array<Instance> = [];
  if (!existsSync(root)) return found;
  for (const dir of readdirSync(root)) {
    for (const file of readdirSync(join(root, dir)).filter((f) => f.endsWith(".sqlite") && f !== "metadata.sqlite")) {
      const db = new DatabaseSync(join(root, dir, file), { readOnly: true });
      try {
        const kv = (key: string) => {
          const row = db.prepare("SELECT value FROM _cf_KV WHERE key = ?").get(key) as { value: Uint8Array } | undefined;
          return row === undefined ? undefined : deserialize(Buffer.from(row.value));
        };
        const meta = kv("INSTANCE_METADATA") as { instance?: { id?: string } } | undefined;
        const status = kv("ENGINE_STATUS") as number | undefined;
        const rows = db.prepare("SELECT event, target, metadata FROM states ORDER BY id DESC LIMIT 4").all() as Array<{
          event: number;
          target: string | null;
          metadata: string;
        }>;
        found.push({
          workflow: dir.replace("miniflare-workflows-", ""),
          id: meta?.instance?.id ?? file,
          status: status === undefined ? "queued" : (STATUS[status] ?? String(status)),
          lastEvents: rows.map((r) => `${EVENTS[r.event] ?? r.event} ${r.target ?? ""} ${r.metadata.slice(0, 200)}`.trim()),
        });
      } catch (error) {
        found.push({ workflow: dir, id: file, status: "unreadable", lastEvents: [String(error)] });
      } finally {
        db.close();
      }
    }
  }
  return found;
};

const main = async () => {
  note(`scenario ${name}: ${JSON.stringify(scenario)}`);
  const fake = await startFake(FAKE_PORT, NO_FAULTS);
  const migrate = spawnSync(
    "npx",
    ["wrangler", "d1", "migrations", "apply", "parsejudge", "--local", "-c", "stress/wrangler.jsonc", "--persist-to", persist],
    { cwd: API_DIR, env: { ...process.env, CI: "1" }, encoding: "utf8" },
  );
  if (migrate.status !== 0) throw new Error(`migrations failed: ${migrate.stderr}${migrate.stdout}`);
  await startWrangler(fake.url);
  note("wrangler ready");

  // Uploads and run creation happen without faults, so every run starts; faults begin with the runs.
  const runIds: Array<string> = [];
  const uploads = Array.from({ length: scenario.runs }, (_, run) =>
    Array.from({ length: scenario.docsPerRun }, (_, doc) => ({ run, doc })),
  ).flat();
  const documents = new Map<number, Array<string>>();
  for (let i = 0; i < uploads.length; i += 4) {
    await Promise.all(
      uploads.slice(i, i + 4).map(async ({ run, doc }) => {
        const pdf = makePdf(`Statement ${run}-${doc}`, scenario.pagesPerDoc, run * 1000 + doc);
        const { documentId } = await post(`/v1/documents?filename=statement-${run}-${doc}.pdf`, pdf, "application/pdf");
        documents.set(run, [...(documents.get(run) ?? []), String(documentId)]);
      }),
    );
  }
  note(`uploaded ${uploads.length} documents`);
  fake.setFaults(scenario.faults);
  await Promise.all(
    Array.from({ length: scenario.runs }, async (_, run) => {
      const created = await post(
        "/v1/runs",
        JSON.stringify({
          documentIds: documents.get(run),
          presetIds: scenario.presets,
          title: `stress ${name} ${run}`,
          credentials: { mistral_ocr: { MISTRAL_API_KEY: "fake-mistral-key" } },
        }),
        "application/json",
      );
      runIds.push(String(created.runId));
    }),
  );
  note(`started ${runIds.length} runs: ${runIds.join(", ")}`);
  const runsStartedAt = Date.now();

  const kills = [...(scenario.kills ?? [])];
  const lastChange = new Map<string, { at: number; state: string }>();
  const continued: Array<{ runId: string; at: number; response: string }> = [];
  const deadline = runsStartedAt + scenario.deadlineMinutes * 60_000;
  let terminal = new Set<string>();
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    const elapsed = (Date.now() - runsStartedAt) / 1000;
    if (kills.length > 0 && elapsed >= (kills[0] ?? 0)) {
      kills.shift();
      note("killing wrangler (SIGKILL)");
      await killWrangler();
      await new Promise((resolve) => setTimeout(resolve, 5000));
      await withRetry(() => startWrangler(fake.url));
      note("wrangler restarted");
    }
    // Read every unfinished run through the API, as the web app does: reading a run reconciles one whose run workflow errored.
    await Promise.all(
      runIds
        .filter((id) => !terminal.has(id))
        .map((id) =>
          fetch(`${API}/v1/runs/${id}`, { headers: USER }).then(
            (res) => res.body?.cancel(),
            () => undefined,
          ),
        ),
    );
    try {
      const db = d1();
      const rows = runIds.map((id) => {
        const r = db.prepare("SELECT status FROM runs WHERE id = ?").get(id) as { status: string };
        const n = db.prepare("SELECT COUNT(*) AS n FROM parses WHERE run_id = ?").get(id) as { n: number };
        const judged = db
          .prepare(
            "SELECT (SELECT COUNT(*) FROM verdicts WHERE run_id = ?1) + (SELECT COUNT(*) FROM judge_failures WHERE run_id = ?1) AS n",
          )
          .get(id) as { n: number };
        return { id, status: r.status, cells: n.n, state: `${r.status} ${n.n} ${judged.n}` };
      });
      db.close();
      terminal = new Set(rows.filter((r) => r.status === "succeeded" || r.status === "failed").map((r) => r.id));
      console.log(
        `[${Math.round(elapsed)}s] terminal ${terminal.size}/${runIds.length}; cells ${rows.map((r) => `${r.status[0]}${r.cells}`).join(" ")}`,
      );
      const toContinue = (r: { id: string; status: string }) =>
        scenario.continueFailed === true && r.status === "failed" && !continued.some((c) => c.runId === r.id);
      if (terminal.size === runIds.length && kills.length === 0 && !rows.some(toContinue)) break;
      for (const row of rows) {
        const last = lastChange.get(row.id);
        if (last?.state !== row.state) lastChange.set(row.id, { at: Date.now(), state: row.state });
        const idle = (Date.now() - (lastChange.get(row.id)?.at ?? Date.now())) / 1000;
        const limit = scenario.continueWhenIdleSeconds;
        const idleRunning = limit !== undefined && !terminal.has(row.id) && idle >= limit;
        if ((!idleRunning && !toContinue(row)) || continued.some((c) => c.runId === row.id)) continue;
        const response = await fetch(`${API}/v1/runs/${row.id}/continue`, { method: "POST", headers: USER })
          .then(async (res) => `HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
          .catch((error: unknown) => `request failed: ${String(error)}`);
        continued.push({ runId: row.id, at: Math.round(elapsed), response });
        note(`Continue ${row.id} after ${Math.round(idle)}s idle: ${response}`);
      }
    } catch (error) {
      console.log(`status read failed: ${String(error)}`);
    }
  }
  const durationSeconds = Math.round((Date.now() - runsStartedAt) / 1000);
  note(terminal.size === runIds.length ? "all runs terminal" : "deadline reached");

  // Let in-flight steps settle before reading final state, then stop wrangler so the files are quiet.
  await new Promise((resolve) => setTimeout(resolve, 3000));
  const db = d1();
  const checks = runIds.map((id) => checkRun(db, id, scenario.presets.length));
  db.close();
  await killWrangler();
  const instances = workflowInstances();
  const pageIds = new Map<string, Array<string>>();
  const evidence = d1();
  for (const runId of runIds)
    pageIds.set(
      runId,
      (
        evidence
          .prepare("SELECT p.id FROM pages p JOIN run_documents rd ON rd.document_id = p.document_id WHERE rd.run_id = ?")
          .all(runId) as Array<{ id: string }>
      ).map((p) => p.id),
    );
  evidence.close();
  const byId = new Map(instances.map((i) => [i.id, i]));
  // A run is stuck on its RunWorkflow step, on page workflows that did not complete, or on pages with no instance.
  const stuck = checks
    .filter((c) => !terminal.has(c.runId))
    .map((c) => {
      const pages = (pageIds.get(c.runId) ?? []).map((pageId) => ({ pageId, instance: byId.get(`${c.runId}-${pageId}`) }));
      return {
        runId: c.runId,
        runWorkflow: byId.get(c.runId) ?? null,
        pagesWithoutInstance: pages.filter((p) => p.instance === undefined).map((p) => p.pageId),
        pagesNotComplete: pages.flatMap((p) =>
          p.instance === undefined || p.instance.status === "complete" ? [] : [p.instance],
        ),
      };
    });
  const failures = checks.filter(
    (c) => !terminal.has(c.runId) || c.pagesMissingParses.length > 0 || c.pagesSilentlyUnjudged.length > 0,
  );
  const report = {
    scenario: name,
    config: scenario,
    pass: failures.length === 0,
    durationSeconds,
    runs: checks,
    stuck,
    continued,
    fakeStats: Object.fromEntries([...fake.stats.entries()].sort()),
    events,
  };
  writeFileSync(join(out, "report.json"), JSON.stringify(report, null, 2));
  writeFileSync(join(out, "instances.json"), JSON.stringify(instances, null, 2));
  await fake.close();
  log.end();
  console.log(
    JSON.stringify(
      {
        pass: report.pass,
        durationSeconds,
        runs: checks.map((c) => ({
          runId: c.runId,
          status: c.status,
          error: c.error?.slice(0, 200) ?? null,
          cells: `${c.cellsRecorded}/${c.cellsExpected} (${c.cellsFailed} failed)`,
          pagesMissingParses: c.pagesMissingParses.length,
          judged: `${c.pagesJudgedOrFailed}/${c.pages}`,
          silentlyUnjudged: c.pagesSilentlyUnjudged.length,
          continued: continued.some((x) => x.runId === c.runId),
        })),
        out,
      },
      null,
      2,
    ),
  );
  process.exit(report.pass ? 0 : 1);
};

main().catch(async (error: unknown) => {
  console.error(error);
  await killWrangler().catch(() => undefined);
  process.exit(3);
});
