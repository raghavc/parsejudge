export interface Preset {
  readonly id: string;
  readonly provider: string;
  readonly label: string;
  readonly mode: string;
  readonly listPriceUsdPerPage: number;
  readonly hosted: boolean;
  readonly default: boolean;
}

export interface Interval {
  readonly low: number;
  readonly high: number;
}

export interface PresetSummary {
  readonly presetId: string;
  readonly label: string;
  readonly pages: number;
  readonly failedPages: number;
  readonly meanScore: number | null;
  readonly medianScore: number | null;
  readonly highSeverityRate: number | null;
  readonly highSeverityInterval: Interval | null;
  readonly listPriceUsdPerPage: number;
  readonly observedCostUsdPerPage: number | null;
  readonly latencyMsMean: number | null;
  readonly latencyMsP50: number | null;
  readonly latencyMsP95: number | null;
}

export interface RunSummary {
  readonly presets: ReadonlyArray<PresetSummary>;
  readonly headToHead: ReadonlyArray<{ presetId: string; opponentId: string; wins: number; ties: number; losses: number }>;
  readonly tradeoff: ReadonlyArray<{ presetId: string; listPriceUsdPerPage: number; meanScore: number; pareto: boolean }>;
}

export interface PageRef {
  readonly id: string;
  readonly index: number;
  readonly imageUrl: string;
}

export interface DocumentInfo {
  readonly id: string;
  readonly filename: string;
  readonly format: string;
  readonly pages: ReadonlyArray<PageRef>;
}

export interface Run {
  readonly id: string;
  readonly shareId: string;
  readonly title: string | null;
  readonly status: string;
  readonly presetIds: ReadonlyArray<string>;
  readonly judgeVersion: string;
  readonly judgeModel: string;
  readonly documents: ReadonlyArray<DocumentInfo>;
  readonly scores: ReadonlyArray<CellScore>;
  readonly summary: RunSummary | null;
  readonly error: string | null;
  readonly createdAt: number;
  readonly completedAt: number | null;
}

export interface JudgedError {
  readonly category: string;
  readonly severity: "not_error" | "low" | "medium" | "high";
  readonly description: string;
}

export interface PageParse {
  readonly presetId: string;
  readonly status: string;
  readonly latencyMs: number | null;
  readonly queueMs: number | null;
  readonly markdown: string | null;
  readonly error: string | null;
  readonly score: number | null;
  readonly reasoning: string | null;
  readonly errors: ReadonlyArray<JudgedError> | null;
}

export interface PageDetail {
  readonly pageId: string;
  readonly imageUrl: string;
  readonly parses: ReadonlyArray<PageParse>;
}

export interface CellScore {
  readonly pageId: string;
  readonly presetId: string;
  readonly status: string;
  readonly score: number | null;
}

export interface CellDone {
  readonly presetId: string;
  readonly pageId: string;
  readonly ok: boolean;
  readonly latencyMs: number | null;
}

export type RunEvent =
  | {
      readonly type: "progress";
      readonly done: number;
      readonly total: number;
      readonly status: string | null;
      readonly cells: ReadonlyArray<CellDone>;
    }
  | ({ readonly type: "parse_done" } & CellDone)
  | { readonly type: "page_done"; readonly pageId: string; readonly done: number; readonly total: number }
  | { readonly type: "run_done"; readonly status: "succeeded" | "failed" };

const USER_KEY = "parsejudge.user";

/** Stand-in for email sign-in: the API's dev auth mode trusts this header. */
export const currentUser = () => localStorage.getItem(USER_KEY);
export const signIn = (email: string) => localStorage.setItem(USER_KEY, email);
const userHeaders = (): Record<string, string> => {
  const email = currentUser();
  return email === null ? {} : { "x-parsejudge-user": email };
};

const json = async <T>(response: Response): Promise<T> => {
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return (await response.json()) as T;
};

export const api = {
  presets: () => fetch("/v1/presets").then(json<ReadonlyArray<Preset>>),
  upload: (file: File) =>
    fetch(`/v1/documents?filename=${encodeURIComponent(file.name)}`, {
      method: "POST",
      headers: { ...userHeaders(), "content-type": file.type || "application/octet-stream" },
      body: file,
    }).then(json<{ documentId: string; pageCount: number }>),
  createRun: (body: {
    documentIds: ReadonlyArray<string>;
    presetIds: ReadonlyArray<string>;
    title?: string | undefined;
    credentials: Record<string, Record<string, string>>;
  }) =>
    fetch("/v1/runs", {
      method: "POST",
      headers: { ...userHeaders(), "content-type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<{ runId: string; shareId: string }>),
  title: (filenames: ReadonlyArray<string>) =>
    fetch("/v1/titles", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filenames }),
    }).then(json<{ title: string | null }>),
  shared: (shareId: string) => fetch(`/v1/share/${shareId}`).then(json<Run>),
  page: (runId: string, pageId: string) => fetch(`/v1/runs/${runId}/pages/${pageId}`).then(json<PageDetail>),
  events: (runId: string, onEvent: (event: RunEvent) => void) => {
    const socket = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/v1/runs/${runId}/events`);
    socket.onmessage = (message) => onEvent(JSON.parse(String(message.data)) as RunEvent);
    return () => socket.close();
  },
};
