/* The run report's interactive charts, ported from the design's evaluate-results.js:
   score vs price / latency (log x), head to head, and where providers disagree
   (range / line / distribution views, gap filter, head-to-head focus, page popover).
   `mountReport` builds into the report's own hosts and returns a cleanup. */
import type { PageDetail } from "../api.ts";

export interface Entry {
  readonly id: string;
  readonly tone: string;
  /** Chart label: the provider, plus the mode when the run has two modes of it. */
  readonly provider: string;
  /** The provider alone, for rows that show the mode beside it. */
  readonly short: string;
  readonly fullName: string;
  readonly mode: string;
  readonly mean: number;
  /** USD per page. */
  readonly price: number;
  /** Seconds, p50. */
  readonly p50: number | null;
}

export interface PageRow {
  readonly id: string;
  readonly doc: string;
  readonly page: number;
  readonly imageUrl: string;
  readonly note: string | null;
  readonly by: Readonly<Record<string, number | null>>;
  readonly min: number;
  readonly max: number;
  readonly gap: number;
  readonly mean: number;
}

type Outcome = "wins" | "ties" | "losses";
export type HeadToHead = Readonly<Record<string, Readonly<Record<string, Readonly<Record<Outcome, ReadonlyArray<string>>>>>>>;

export interface ReportData {
  readonly entries: ReadonlyArray<Entry>;
  readonly pages: ReadonlyArray<PageRow>;
  readonly h2h: HeadToHead;
  /** Page images and parser output are private to the owner. */
  readonly contentHidden: boolean;
  readonly detail: (pageId: string) => Promise<PageDetail | null>;
  readonly compare: (pageId: string) => string;
  readonly navigate: (href: string) => void;
}

const NS = "http://www.w3.org/2000/svg";
const esc = (s: unknown) =>
  String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c);
const svgEl = (tag: string, attrs: Record<string, string | number>, parent?: Element) => {
  const el = document.createElementNS(NS, tag);
  for (const k in attrs) el.setAttribute(k, String(attrs[k]));
  if (parent) parent.appendChild(el);
  return el;
};
const docShort = (d: string) => d.replace(/\.[^.]+$/i, "");
const SEV_RANK: Record<string, number> = { high: 0, medium: 1, low: 2, not_error: 3 };
const category = (c: string) => {
  const s = c.replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** 1-2-5 log ticks from the largest tick at or under `lo` to the smallest at or over `hi`. */
export const logTicks = (lo: number, hi: number) => {
  const all: number[] = [];
  for (let e = Math.floor(Math.log10(lo)) - 1; e <= Math.ceil(Math.log10(hi)) + 1; e++)
    for (const m of [1, 2, 5]) all.push(Number((m * 10 ** e).toPrecision(3)));
  const first = all.filter((t) => t <= lo).at(-1) ?? all[0] ?? lo;
  const last = all.find((t) => t >= hi && t > first) ?? hi;
  return all.filter((t) => t >= first && t <= last);
};

const ICON: Record<string, string> = {
  "chevron-left": '<path d="m15 18-6-6 6-6"/>',
  "chevron-right": '<path d="m9 18 6-6-6-6"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  "arrow-up-right": '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
  "chart-candlestick":
    '<path d="M9 5v4"/><rect width="4" height="6" x="7" y="9" rx="1"/><path d="M9 15v2"/><path d="M17 3v2"/><rect width="4" height="8" x="15" y="5" rx="1"/><path d="M17 13v3"/><path d="M3 3v16a2 2 0 0 0 2 2h16"/>',
  "chart-line": '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="m19 9-5 5-4-4-3 3"/>',
  "chart-area":
    '<path d="M3 3v16a2 2 0 0 0 2 2h16"/><path d="M7 11.207a.5.5 0 0 1 .146-.353l2-2a.5.5 0 0 1 .708 0l3.292 3.292a.5.5 0 0 0 .708 0l4.292-4.292a.5.5 0 0 1 .854.353V16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1z"/>',
};
const icon = (n: string) =>
  `<svg class="lucide lucide-${n}" xmlns="${NS}" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n] ?? ""}</svg>`;

export const mountReport = (root: HTMLElement, R: ReportData): (() => void) => {
  const E = R.entries;
  const P = R.pages;
  const $ = (id: string) => root.querySelector<HTMLElement>(`#${id}`) as HTMLElement;
  const frame = (root.closest(".pjx") ?? document.body) as HTMLElement;
  const pane = root.closest(".content-pane") as HTMLElement | null;
  const cleanups: Array<() => void> = [];
  const on = <K extends keyof DocumentEventMap>(
    target: Document | Window | HTMLElement,
    type: K | string,
    fn: (e: never) => void,
    opts?: AddEventListenerOptions | boolean,
  ) => {
    target.addEventListener(type, fn as EventListener, opts);
    cleanups.push(() => target.removeEventListener(type, fn as EventListener, opts));
  };
  const score = (pg: PageRow, id: string) => pg.by[id] ?? null;

  function axisTitles(
    svg: Element,
    W: number,
    H: number,
    m: { l: number; r: number; t: number; b: number },
    xt: string,
    yt: string,
  ) {
    const xl = svgEl("text", { class: "ax-t ax-x", x: (m.l + W - m.r) / 2, y: H - 2, "text-anchor": "middle" }, svg);
    xl.textContent = xt;
    const cy = (m.t + H - m.b) / 2;
    svgEl("text", { class: "ax-t", x: 10, y: cy, "text-anchor": "middle", transform: `rotate(-90 10 ${cy})` }, svg).textContent =
      yt;
    return xl;
  }

  /* ---------- shared tooltip ---------- */
  const tip = document.createElement("div");
  tip.className = "dg-tip";
  frame.appendChild(tip);
  cleanups.push(() => tip.remove());
  const place = (x: number) => Math.max(8 + tip.offsetWidth / 2, Math.min(x, innerWidth - 8 - tip.offsetWidth / 2));
  function showTipBelow(html: string, x: number, y: number) {
    tip.innerHTML = html;
    tip.style.left = `${place(x)}px`;
    tip.style.top = `${y + 8}px`;
    tip.classList.add("show");
  }
  function showTip(html: string, x: number, y: number) {
    tip.innerHTML = html;
    tip.style.left = `${place(x)}px`;
    tip.style.top = `${y - tip.offsetHeight - 8}px`;
    tip.classList.add("show");
  }
  const hideTip = () => tip.classList.remove("show");

  /* ---------- score vs price / latency (log x) ---------- */
  function scatter(
    host: HTMLElement,
    xOf: (e: Entry) => number | null,
    fmt: (v: number) => string,
    detail: (e: Entry) => string,
    xTitle: string,
  ) {
    host.innerHTML = "";
    const pts = E.filter((e) => xOf(e) !== null && (xOf(e) as number) > 0);
    if (pts.length === 0) return;
    const xs = pts.map((e) => xOf(e) as number);
    /* pad the log domain so the cheapest and dearest points sit off the plot edges */
    const pad = Math.max(0.15, 0.08 * (Math.log(Math.max(...xs)) - Math.log(Math.min(...xs))));
    const lx0 = Math.log(Math.min(...xs)) - pad;
    const lx1 = Math.log(Math.max(...xs)) + pad;
    const ticks = logTicks(Math.exp(lx0), Math.exp(lx1)).filter((t) => Math.log(t) >= lx0 && Math.log(t) <= lx1);
    const W = Math.max(280, host.clientWidth);
    const H = 228;
    const m = { l: 42, r: 18, t: 10, b: 42 };
    const svg = svgEl("svg", { class: "chart sc-in", width: W, height: H, viewBox: `0 0 ${W} ${H}` }, host);
    const sx = (v: number) => m.l + ((Math.log(v) - lx0) / (lx1 - lx0 || 1)) * (W - m.l - m.r);
    const lo = Math.max(1, Math.floor(Math.min(...pts.map((e) => e.mean))) - 1);
    const sy = (v: number) => m.t + ((10 - v) / (10 - lo)) * (H - m.t - m.b);
    /* the better quadrant: higher score for less (upper left of the plot's midpoints) */
    const midX = (m.l + W - m.r) / 2;
    const midY = (m.t + H - m.b) / 2;
    svgEl("rect", { class: "zone", x: m.l, y: m.t, width: midX - m.l, height: midY - m.t, rx: 4 }, svg);
    svgEl("text", { class: "zone-l", x: m.l + 8, y: m.t + 16 }, svg).textContent = "Ideal";
    for (let v = lo; v <= 10; v++) {
      svgEl("line", { class: v === lo ? "base" : "grid", x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v) }, svg);
      svgEl("text", { class: "ax", x: m.l - 8, y: sy(v) + 4, "text-anchor": "end" }, svg).textContent = String(v);
    }
    for (const t of ticks)
      svgEl("text", { class: "ax", x: sx(t), y: H - m.b + 16, "text-anchor": "middle" }, svg).textContent = fmt(t);
    axisTitles(svg, W, H, m, xTitle, "Mean score");
    /* labels: right of the point, nudged apart vertically when two collide */
    const placed: number[] = [];
    pts
      .slice()
      .sort((a, b) => b.mean - a.mean)
      .forEach((e, i) => {
        const cx = sx(xOf(e) as number);
        const cy = sy(e.mean);
        const g = svgEl("g", { class: `sc-pt s-${e.tone}`, style: `animation-delay:${i * 60}ms` }, svg);
        svgEl("circle", { cx, cy, r: 5 }, g);
        let ly = cy + 4;
        for (const p of placed) if (Math.abs(p - ly) < 15) ly = p + 15;
        placed.push(ly);
        const right = cx < W - 110;
        const t = svgEl("text", { x: right ? cx + 10 : cx - 10, y: ly, "text-anchor": right ? "start" : "end" }, g);
        t.innerHTML = `${esc(e.provider)} <tspan class="v">${e.mean.toFixed(1)}</tspan>`;
        g.addEventListener("mouseenter", () => {
          const r = (g.querySelector("circle") as SVGCircleElement).getBoundingClientRect();
          showTip(
            `${esc(e.fullName)} <span class="m">· ${esc(e.mode)}</span><br>${e.mean.toFixed(2)} mean · ${detail(e)}`,
            r.left + r.width / 2,
            r.top,
          );
        });
        g.addEventListener("mouseleave", hideTip);
      });
  }
  const priceK = (v: number) => {
    const k = v * 1000;
    return k < 10 ? String(Math.round(k * 100) / 100) : String(Math.round(k));
  };
  function charts() {
    scatter(
      $("chPrice"),
      (e) => e.price * 1000,
      (v) => `$${v}`,
      (e) => `$${priceK(e.price)} / 1k pages`,
      "Price per 1k pages (log)",
    );
    scatter(
      $("chLatency"),
      (e) => e.p50,
      (v) => `${v} s`,
      (e) => `${(e.p50 ?? 0).toFixed(1)} s p50`,
      "p50 latency (log)",
    );
  }

  /* ---------- head to head ---------- */
  let h2hOn: string | null = null;
  const ent = (id: string) => E.find((e) => e.id === id) as Entry;
  function h2h() {
    const head = `<tr><th></th>${E.map((e) => `<th>vs ${esc(e.provider)}</th>`).join("")}</tr>`;
    const rows = E.map(
      (a) =>
        `<tr><td><span class="rn">${esc(a.provider)}</span></td>${E.map((b) => {
          if (a === b) return '<td class="dash">—</td>';
          const r = R.h2h[a.id]?.[b.id];
          if (!r) return '<td class="dash">—</td>';
          const n = (k: Outcome, cls: string) =>
            `<button class="h2h-n ${cls}" type="button" data-a="${a.id}" data-b="${b.id}" data-k="${k}"${r[k].length && !R.contentHidden ? "" : " disabled"}>${r[k].length}</button>`;
          return `<td>${n("wins", "w")}<span class="sep">·</span>${n("ties", "t")}<span class="sep">·</span>${n("losses", "l")}</td>`;
        }).join("")}</tr>`,
    ).join("");
    $("h2h").innerHTML = `<thead>${head}</thead><tbody>${rows}</tbody>`;
    for (const b of $("h2h").querySelectorAll<HTMLButtonElement>(".h2h-n"))
      b.onclick = () => {
        const { a: ai = "", b: bi = "", k = "wins" } = b.dataset;
        const key = ai + bi + k;
        if (h2hOn === key) {
          setFocus(null);
          return;
        }
        const a = ent(ai);
        const c = ent(bi);
        const verb = k === "wins" ? "over" : k === "losses" ? "under" : "tied with";
        setFocus({ key, ids: new Set(R.h2h[ai]?.[bi]?.[k as Outcome] ?? []), label: `${a.provider} ${verb} ${c.provider}` });
        $("dgCard").scrollIntoView({ behavior: "smooth", block: "center" });
      };
  }

  /* ============================================================
     WHERE PROVIDERS DISAGREE
     ============================================================ */
  const GAPS: ReadonlyArray<[number, string]> = [
    [0, "All"],
    [2, "2+"],
    [3, "3+"],
    [5, "5+"],
  ];
  const BY_GAP = P.slice().sort((a, b) => b.gap - a.gap || a.mean - b.mean);
  let ORDER = BY_GAP.slice();
  const pageNo = (pg: PageRow) => P.indexOf(pg) + 1;
  const st: {
    thr: number;
    focus: { key: string; ids: Set<string>; label: string } | null;
    emph: string | null;
    sel: number;
    kb: number;
    kbMode: boolean;
    view: "range" | "line" | "area";
    sort: "page" | "gap";
  } = { thr: 0, focus: null, emph: null, sel: -1, kb: -1, kbMode: false, view: "line", sort: "gap" };
  const VIEWS: ReadonlyArray<[typeof st.view, string, string]> = [
    ["range", "chart-candlestick", "Range"],
    ["line", "chart-line", "Lines"],
    ["area", "chart-area", "Distribution"],
  ];
  let lines: SVGElement[] = [];
  type Col = { g: SVGElement; bg: SVGElement; pg: PageRow; pts: SVGElement[]; cx: number };
  let geo: { W: number; H: number; slot: number } | null = null;
  let cols: Col[] = [];
  let band: SVGElement | null = null;

  function seg() {
    $("dgSeg").innerHTML = GAPS.map(
      ([v, l]) =>
        `<button class="mode-btn${v === st.thr ? " active" : ""}" type="button" role="tab" aria-selected="${v === st.thr}" data-g="${v}">${l}</button>`,
    ).join("");
    for (const b of $("dgSeg").querySelectorAll<HTMLButtonElement>("[data-g]"))
      b.onclick = () => {
        st.thr = Number(b.dataset.g);
        seg();
        apply();
      };
  }
  function viewSeg() {
    $("dgView").innerHTML = VIEWS.map(
      ([v, ic, tipT]) =>
        `<button class="mode-btn icon${v === st.view ? " active" : ""}" type="button" role="tab" aria-selected="${v === st.view}" aria-label="${tipT}" data-v="${v}">${icon(ic)}</button>`,
    ).join("");
    for (const b of $("dgView").querySelectorAll<HTMLButtonElement>("[data-v]")) {
      b.onmouseenter = () => {
        const r = b.getBoundingClientRect();
        showTipBelow(b.getAttribute("aria-label") ?? "", r.left + r.width / 2, r.bottom);
      };
      b.onmouseleave = hideTip;
      b.onclick = () => {
        if (st.view === b.dataset.v) return;
        st.view = b.dataset.v as typeof st.view;
        close();
        hideTip();
        viewSeg();
        $("dgSeg").hidden = st.view === "area";
        sortSeg();
        /* cross-fade: the old view settles out, the new one draws in */
        const host = $("dgWrap");
        host.classList.add("is-swap");
        setTimeout(() => {
          build(true);
          host.classList.remove("is-swap");
        }, 140);
      };
    }
  }
  function sortSeg() {
    const host = $("dgSort");
    host.hidden = st.view === "area";
    host.innerHTML = (
      [
        ["page", "Page order"],
        ["gap", "Widest gap"],
      ] as const
    )
      .map(
        ([v, l]) =>
          `<button class="mode-btn${v === st.sort ? " active" : ""}" type="button" role="tab" aria-selected="${v === st.sort}" data-s="${v}">${l}</button>`,
      )
      .join("");
    for (const b of host.querySelectorAll<HTMLButtonElement>("[data-s]"))
      b.onclick = () => {
        if (st.sort === b.dataset.s) return;
        st.sort = b.dataset.s as typeof st.sort;
        sortSeg();
        close();
        hideTip();
        /* FLIP: remember each page's x, rebuild in the new order, slide every column home */
        const was: Record<string, number> = {};
        for (const c of cols) was[c.pg.id] = c.cx;
        ORDER = st.sort === "gap" ? BY_GAP.slice() : P.slice();
        build(false);
        const svg = $("dgWrap").querySelector("svg") as SVGSVGElement;
        for (const c of cols)
          for (const el of [c.g, c.bg]) {
            el.style.transition = "none";
            el.style.transform = `translateX(${(was[c.pg.id] ?? c.cx) - c.cx}px)`;
          }
        for (const l of lines) l.style.opacity = "0";
        void svg.getBoundingClientRect();
        requestAnimationFrame(() => {
          for (const c of cols)
            for (const el of [c.g, c.bg]) {
              el.style.transition = "";
              el.style.transform = "";
            }
          for (const l of lines) l.style.opacity = "";
        });
      };
  }
  function legend() {
    $("dgLegend").innerHTML = E.map(
      (e) =>
        `<button class="dg-leg s-${e.tone}${st.emph === e.id ? " is-on" : ""}" type="button" data-e="${e.id}" aria-pressed="${st.emph === e.id}"><span class="s-dot"></span>${esc(e.provider)}</button>`,
    ).join("");
    $("dgLegend").classList.toggle("has-on", !!st.emph);
    for (const b of $("dgLegend").querySelectorAll<HTMLButtonElement>("[data-e]"))
      b.onclick = () => {
        st.emph = st.emph === b.dataset.e ? null : (b.dataset.e ?? null);
        legend();
        apply();
      };
  }
  function setFocus(f: typeof st.focus) {
    st.focus = f;
    h2hOn = f ? f.key : null;
    for (const b of root.querySelectorAll<HTMLButtonElement>(".h2h-n"))
      b.classList.toggle("is-on", !!f && (b.dataset.a ?? "") + (b.dataset.b ?? "") + (b.dataset.k ?? "") === f.key);
    $("dgFocus").innerHTML = f
      ? `<span class="dg-focus">${esc(f.label)} · ${f.ids.size}<button class="sf-x" type="button" aria-label="Clear">${icon("x")}</button></span>`
      : "";
    if (f) ($("dgFocus").querySelector(".sf-x") as HTMLButtonElement).onclick = () => setFocus(null);
    apply();
  }

  const scored = (pg: PageRow) => E.filter((e) => score(pg, e.id) !== null);
  function build(animate: boolean) {
    if (st.view === "area") {
      buildArea(animate);
      return;
    }
    /* hold the chart's height across the rebuild so the page never jumps (scroll anchoring) */
    const host = $("dgWrap");
    host.style.minHeight = `${host.offsetHeight}px`;
    host.innerHTML = "";
    requestAnimationFrame(() => {
      host.style.minHeight = "";
    });
    area = null;
    const isLine = st.view === "line";
    const W = Math.max(480, host.clientWidth);
    const H = 296;
    const m = { l: 42, r: 4, t: 10, b: 38 };
    const n = ORDER.length;
    const slot = (W - m.l - m.r) / Math.max(1, n);
    const lo = Math.max(0, Math.min(10, ...P.map((p) => p.min)) - 1);
    const sy = (v: number) => m.t + ((10 - v) / (10 - lo)) * (H - m.t - m.b);
    geo = { W, H, slot };
    const svg = svgEl(
      "svg",
      {
        class: `chart dg-svg${isLine ? " is-line" : ""}${st.sort === "page" ? " by-page" : ""}${animate ? " is-pre" : ""}`,
        width: W,
        height: H,
        viewBox: `0 0 ${W} ${H}`,
        role: "img",
      },
      host,
    );
    band = svgEl("rect", { class: "band", x: m.l, y: m.t - 4, height: H - m.t - m.b + 4, rx: 4 }, svg);
    axisTitles(svg, W, H, m, st.sort === "gap" ? "Score gap, widest first" : "Page", "Score");
    for (let v = lo; v <= 10; v++) {
      svgEl("line", { class: v === lo ? "base" : "grid", x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v) }, svg);
      if ((v - lo) % (10 - lo > 6 ? 2 : 1) === 0 || v === 10)
        svgEl("text", { class: "ax", x: m.l - 8, y: sy(v) + 4, "text-anchor": "end" }, svg).textContent = String(v);
    }
    /* column washes live in their own layer UNDER the lines; each column's marks sit above */
    const bgLayer = svgEl("g", {}, svg);
    /* line view: one path per provider through its score on every page; a failed page breaks the line */
    lines = isLine
      ? E.map((e) => {
          let d = "";
          let pen = false;
          ORDER.forEach((pg, i) => {
            const s = score(pg, e.id);
            if (s === null) {
              pen = false;
              return;
            }
            d += `${pen ? "L" : "M"}${(m.l + slot * (i + 0.5)).toFixed(1)},${sy(s).toFixed(1)}`;
            pen = true;
          });
          return svgEl("path", { class: `dg-line s-${e.tone}`, "data-e": e.id, d, pathLength: 1 }, svg);
        })
      : [];
    /* gap order: one label per run of equal gaps, centred under the run, dropped when it would crowd the last */
    const gapLabels = new Map<number, { x: number; gap: number }>();
    if (st.sort === "gap") {
      let start = 0;
      let lastX = Number.NEGATIVE_INFINITY;
      ORDER.forEach((pg, i) => {
        if (ORDER[i + 1]?.gap === pg.gap) return;
        const x = m.l + (slot * (start + i + 1)) / 2;
        if (x - lastX >= 20) {
          gapLabels.set(Math.floor((start + i) / 2), { x, gap: pg.gap });
          lastX = x;
        }
        start = i + 1;
      });
    }
    cols = ORDER.map((pg, i) => {
      const cx = m.l + slot * (i + 0.5);
      const g = svgEl("g", { class: "dg-col", "data-i": i, style: `--d:${animate ? Math.min(i * 12, 520) : 0}ms` }, svg);
      const bg = svgEl("g", { class: "dg-bg" }, bgLayer);
      svgEl("rect", { class: "qb", x: cx - slot / 2, y: m.t - 4, width: slot, height: H - m.t - m.b + 4 }, bg);
      svgEl(
        "rect",
        { class: "hov", x: cx - slot / 2 + 1, y: m.t - 4, width: Math.max(2, slot - 2), height: H - m.t - m.b + 4, rx: 3 },
        bg,
      );
      const y1 = sy(pg.max);
      const y2 = sy(pg.min);
      /* the rod runs dot centre to dot centre; every dot sits on its axis */
      if (!isLine) svgEl("rect", { class: "rng", x: cx - 1, y: y1, width: 2, height: Math.max(0, y2 - y1), rx: 1 }, g);
      const pts = scored(pg).map((e) =>
        svgEl("circle", { class: `pt s-${e.tone}`, "data-e": e.id, cx, cy: sy(score(pg, e.id) ?? 0), r: isLine ? 2.6 : 3.6 }, g),
      );
      /* axis: the gap under each run of equal gaps when sorted by gap; page numbers at a stride in page order */
      const pn = i + 1;
      const stride = n > 120 ? 50 : n > 60 ? 20 : 10;
      const gapLabel = gapLabels.get(i);
      if (st.sort === "gap") {
        if (gapLabel) svgEl("text", { class: "gap-l", x: gapLabel.x, y: H - m.b + 16 }, g).textContent = String(gapLabel.gap);
      } else if (pn === 1 || pn % stride === 0 || pn === n)
        svgEl("text", { class: "ax pg-l", x: cx, y: H - m.b + 16, "text-anchor": "middle" }, g).textContent = String(pn);
      /* hit area = the plot only, never the axes */
      svgEl("rect", { class: "hit", x: cx - slot / 2, y: m.t - 4, width: slot, height: H - m.t - m.b + 4 }, g);
      return { g, bg, pg, pts, cx };
    });
    svg.addEventListener("mouseover", (e) => {
      const g = (e.target as Element).closest(".dg-col") as SVGElement | null;
      if (g) hover(Number(g.dataset.i));
      else {
        hideTip();
        for (const c of cols) c.bg.classList.remove("is-hov");
      }
    });
    svg.addEventListener("mouseleave", () => {
      hideTip();
      for (const c of cols) c.bg.classList.remove("is-hov");
    });
    svg.addEventListener("click", (e) => {
      const g = (e.target as Element).closest(".dg-col") as SVGElement | null;
      if (g) openAt(Number(g.dataset.i));
    });
    apply();
    if (animate)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          svg.classList.add("is-anim");
          svg.classList.remove("is-pre");
          setTimeout(() => svg.classList.remove("is-anim"), 1100);
        }),
      );
  }
  const inFocus = (pg: PageRow) => !st.focus || st.focus.ids.has(pg.id);
  const qualifies = (pg: PageRow) => (st.focus ? inFocus(pg) : pg.gap >= st.thr);
  function apply() {
    if (st.view === "area") {
      applyArea();
      return;
    }
    if (!geo || !band) return;
    for (const l of lines) {
      l.classList.toggle("is-mute", !!st.emph && l.dataset.e !== st.emph);
      l.classList.toggle("is-dim", !!st.focus);
    }
    const q = ORDER.filter(qualifies).length;
    band.style.width = st.sort === "gap" && !st.focus ? `${Math.max(0, q * geo.slot)}px` : "0px";
    $("dgWrap").querySelector("svg")?.classList.toggle("has-focus", !!st.focus);
    cols.forEach((c, i) => {
      c.g.classList.toggle("is-off", !st.focus && !qualifies(c.pg));
      c.g.classList.toggle("is-out", !inFocus(c.pg));
      c.g.classList.toggle("is-sel", i === st.sel);
      c.g.classList.toggle("is-kb", st.kbMode && i === st.kb && st.sel < 0);
      for (const k of ["is-off", "is-out", "is-sel", "is-kb"]) c.bg.classList.toggle(k, c.g.classList.contains(k));
      for (const p of c.pts) p.classList.toggle("is-mute", !!st.emph && p.dataset.e !== st.emph);
    });
    $("dgCount").textContent = st.focus
      ? `${st.focus.ids.size} of ${P.length} pages`
      : st.thr === 0
        ? `${P.length} pages`
        : `${q} of ${P.length} pages`;
  }
  function hover(i: number) {
    const c = cols[i];
    if (!c) return;
    cols.forEach((x, j) => {
      x.bg.classList.toggle("is-hov", j === i);
    });
    const r = (c.bg.querySelector(".hov") as SVGElement).getBoundingClientRect();
    showTip(
      `<span class="m">${pageNo(c.pg)} ·</span> ${esc(docShort(c.pg.doc))} <span class="m">· p. ${c.pg.page} · gap ${c.pg.gap}</span>`,
      r.left + r.width / 2,
      r.bottom - 2,
    );
  }

  /* ---------- area view: share of pages at or above each score ---------- */
  let area: {
    S: number[];
    sx: (s: number) => number;
    sy: (v: number) => number;
    series: Array<{ e: Entry; fill: SVGElement; line: SVGElement; dot: SVGElement }>;
  } | null = null;
  const areaPages = () => (st.focus ? P.filter(inFocus) : P);
  const share = (pages: ReadonlyArray<PageRow>, id: string, s: number) =>
    pages.length ? pages.filter((p) => (score(p, id) ?? -1) >= s).length / pages.length : 0;
  function buildArea(animate: boolean) {
    const host = $("dgWrap");
    host.style.minHeight = `${host.offsetHeight}px`;
    host.innerHTML = "";
    requestAnimationFrame(() => {
      host.style.minHeight = "";
    });
    cols = [];
    geo = null;
    lines = [];
    const W = Math.max(480, host.clientWidth);
    const H = 296;
    const m = { l: 52, r: 12, t: 10, b: 38 };
    const lo = Math.max(1, Math.min(10, ...P.map((p) => p.min)));
    /* strict → lenient: 10 on the left, lines climb toward 100% */
    const S: number[] = [];
    for (let s = 10; s >= lo; s--) S.push(s);
    const sx = (s: number) => m.l + ((10 - s) / (10 - lo || 1)) * (W - m.l - m.r);
    const sy = (v: number) => m.t + (1 - v) * (H - m.t - m.b);
    const svg = svgEl(
      "svg",
      { class: `chart dg-svg is-area${animate ? " is-pre" : ""}`, width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img" },
      host,
    );
    for (const v of [0, 0.25, 0.5, 0.75, 1]) {
      svgEl("line", { class: v === 0 ? "base" : "grid", x1: m.l, x2: W - m.r, y1: sy(v), y2: sy(v) }, svg);
      svgEl("text", { class: "ax", x: m.l - 8, y: sy(v) + 4, "text-anchor": "end" }, svg).textContent = `${Math.round(v * 100)}%`;
    }
    for (const s of S)
      svgEl("text", { class: "ax", x: sx(s), y: H - m.b + 16, "text-anchor": "middle" }, svg).textContent =
        s === 10 ? "10" : `≥ ${s}`;
    axisTitles(svg, W, H, m, "Score", "Share of pages");
    const guide = svgEl("line", { class: "ar-guide", x1: 0, x2: 0, y1: m.t, y2: H - m.b }, svg);
    const fills = svgEl("g", {}, svg);
    const strokes = svgEl("g", {}, svg);
    const dots = svgEl("g", {}, svg);
    const series = E.map((e) => ({
      e,
      fill: svgEl("path", { class: `ar-fill s-${e.tone}`, "data-e": e.id }, fills),
      line: svgEl("path", { class: `dg-line s-${e.tone}`, "data-e": e.id, pathLength: 1 }, strokes),
      dot: svgEl("circle", { class: `ar-dot s-${e.tone}`, "data-e": e.id, r: 3.6, cx: -20, cy: -20 }, dots),
    }));
    const hit = svgEl(
      "rect",
      { class: "hit", x: m.l, y: m.t, width: W - m.l - m.r, height: H - m.t - m.b, fill: "transparent" },
      svg,
    );
    area = { S, sx, sy, series };
    hit.addEventListener("mousemove", (ev) => {
      const r = svg.getBoundingClientRect();
      const x = (ev as MouseEvent).clientX - r.left;
      const s = S.reduce((b, v) => (Math.abs(sx(v) - x) < Math.abs(sx(b) - x) ? v : b), S[0] ?? 10);
      const pages = areaPages();
      const cx = sx(s);
      guide.setAttribute("x1", String(cx));
      guide.setAttribute("x2", String(cx));
      guide.classList.add("on");
      const vals = series.map((o) => {
        const v = share(pages, o.e.id, s);
        o.dot.setAttribute("cx", String(cx));
        o.dot.setAttribute("cy", String(sy(v)));
        o.dot.classList.add("on");
        return [o.e, v] as const;
      });
      showTip(
        `${s === 10 ? "Scored 10" : `Scored ${s} or higher`}<br>${vals
          .slice()
          .sort((a, b) => b[1] - a[1])
          .map(([e, v]) => `${esc(e.provider)} <span class="m">${Math.round(v * 100)}%</span>`)
          .join(" · ")}`,
        r.left + cx,
        r.top + sy(0) - 6,
      );
    });
    hit.addEventListener("mouseleave", () => {
      hideTip();
      guide.classList.remove("on");
      for (const o of series) o.dot.classList.remove("on");
    });
    applyArea();
    if (animate)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          svg.classList.add("is-anim");
          svg.classList.remove("is-pre");
          setTimeout(() => svg.classList.remove("is-anim"), 900);
        }),
      );
  }
  function applyArea() {
    if (!area) return;
    const { S, sx, sy, series } = area;
    const pages = areaPages();
    for (const o of series) {
      const pts = S.map((s) => [sx(s), sy(share(pages, o.e.id, s))] as const);
      const d = pts.map((p, i) => `${i ? "L" : "M"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join("");
      o.line.setAttribute("d", d);
      const lastX = pts[pts.length - 1]?.[0] ?? 0;
      const firstX = pts[0]?.[0] ?? 0;
      o.fill.setAttribute("d", `${d}L${lastX.toFixed(1)},${sy(0).toFixed(1)}L${firstX.toFixed(1)},${sy(0).toFixed(1)}Z`);
      const mute = !!st.emph && o.e.id !== st.emph;
      o.line.classList.toggle("is-mute", mute);
      o.fill.classList.toggle("is-mute", mute);
    }
    $("dgCount").textContent =
      `Share of ${st.focus ? pages.length : P.length} pages scoring at least each score. Higher is better.`;
  }

  /* ---------- page popover ---------- */
  const details = new Map<string, PageDetail | null>();
  const pop = document.createElement("div");
  pop.className = "pg-pop";
  pop.setAttribute("role", "dialog");
  pop.setAttribute("aria-label", "Page details");
  frame.appendChild(pop);
  cleanups.push(() => pop.remove());
  let popOpen = false;
  function navList() {
    const l = cols.map((_, i) => i).filter((i) => qualifies((cols[i] as Col).pg) && inFocus((cols[i] as Col).pg));
    return l.length ? l : cols.map((_, i) => i);
  }
  function body(pg: PageRow) {
    const d = details.get(pg.id);
    const ranked = E.slice().sort((a, b) => (score(pg, b.id) ?? -1) - (score(pg, a.id) ?? -1));
    const thumb = R.contentHidden
      ? ""
      : `<div><div class="pp-thumb" data-zoom="1"><span class="shim"></span><img alt="" src="${esc(pg.imageUrl)}"></div></div>`;
    const note =
      pg.note ?? d?.parses.filter((p) => p.reasoning).sort((a, b) => (a.score ?? 0) - (b.score ?? 0))[0]?.reasoning ?? "";
    return `<div class="pp-body${R.contentHidden ? " no-thumb" : ""}">
      ${thumb}
      <div class="pp-main">
        ${note ? `<p class="pp-note">${esc(note)}</p>` : ""}
        <div class="pp-rows">${ranked
          .map((e) => {
            const s = score(pg, e.id);
            const parse = d?.parses.find((p) => p.presetId === e.id);
            const errs = (parse?.errors ?? [])
              .filter((x) => x.severity !== "not_error")
              .slice()
              .sort((a, b) => (SEV_RANK[a.severity] ?? 3) - (SEV_RANK[b.severity] ?? 3));
            const items = [
              ...(parse?.warning ? [`<li><span><span class="c hi">Cut off · </span>${esc(parse.warning)}</span></li>`] : []),
              ...errs
                .slice(0, 2)
                .map(
                  (x) =>
                    `<li><span><span class="c${x.severity === "high" ? " hi" : ""}">${x.severity === "high" ? "High · " : ""}${esc(category(x.category))} · </span>${esc(x.description)}</span></li>`,
                ),
              ...(errs.length > 2 ? [`<li><span class="c">${errs.length - 2} more</span></li>`] : []),
            ];
            const list =
              s === null
                ? `<li><span class="c hi">${esc(parse?.error ?? "Failed")}</span></li>`
                : d === undefined
                  ? ""
                  : items.length
                    ? items.join("")
                    : '<li><span class="clean">No errors</span></li>';
            return `<div class="pp-row s-${e.tone}">
            <div class="pp-row-h"><span class="pp-row-n">${esc(e.short)}<span class="m">${esc(e.mode)}</span></span><span class="pp-bar"><span style="width:${(s ?? 0) * 10}%"></span></span><span class="pp-row-s">${s ?? "–"}</span></div>
            <ul class="pp-errs">${list}</ul>
          </div>`;
          })
          .join("")}</div>
      </div>
    </div>`;
  }
  function head(pg: PageRow, i: number) {
    const nl = navList();
    const k = nl.indexOf(i);
    return `<div class="pp-head">
      <div class="pp-title"><span class="d">${esc(docShort(pg.doc))}</span><span class="p">Page ${pg.page}</span></div>
      <div class="pp-nav">${k >= 0 ? `<span class="pp-pos">${k + 1} / ${nl.length}</span>` : ""}
        <button class="icon-btn" type="button" data-nav="-1" aria-label="Previous page"${(k >= 0 ? k === 0 : !nl.some((j) => j < i)) ? " disabled" : ""}>${icon("chevron-left")}</button>
        <button class="icon-btn" type="button" data-nav="1" aria-label="Next page"${(k >= 0 ? k === nl.length - 1 : !nl.some((j) => j > i)) ? " disabled" : ""}>${icon("chevron-right")}</button>
        <button class="icon-btn" type="button" data-close aria-label="Close">${icon("x")}</button>
      </div>
    </div>`;
  }
  const foot = (pg: PageRow) =>
    R.contentHidden
      ? ""
      : `<div class="pp-foot"><span class="hint"></span><a class="btn" href="${esc(R.compare(pg.id))}" data-go><span class="btn-label">Compare outputs</span>${icon("arrow-up-right")}</a></div>`;

  function placePop(i: number) {
    const c = cols[i];
    if (!c) return;
    const r = (c.bg.querySelector(".hov") as SVGElement).getBoundingClientRect();
    const card = $("dgWrap").getBoundingClientRect();
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let left = r.right + 10;
    let ox = "left";
    if (left + w > innerWidth - 8) {
      left = r.left - 10 - w;
      ox = "right";
    }
    left = Math.max(8, left);
    const top = Math.max(8, Math.min(card.top + card.height / 2 - h / 2, innerHeight - 8 - h));
    pop.style.setProperty("--ox", ox);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
  }
  function wire(pg: PageRow) {
    for (const b of pop.querySelectorAll<HTMLButtonElement>("[data-nav]")) b.onclick = () => step(Number(b.dataset.nav));
    (pop.querySelector("[data-close]") as HTMLButtonElement).onclick = close;
    const go = pop.querySelector<HTMLAnchorElement>("[data-go]");
    if (go)
      go.onclick = (e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        R.navigate(R.compare(pg.id));
      };
    const t = pop.querySelector<HTMLElement>(".pp-thumb");
    if (t) {
      const img = t.querySelector("img") as HTMLImageElement;
      const ok = () => {
        img.classList.add("ok");
        t.querySelector(".shim")?.remove();
      };
      if (img.complete && img.naturalWidth) ok();
      else img.onload = ok;
      t.onclick = () => lightbox(pg.imageUrl);
    }
    /* parser errors come from the page itself, loaded once per page */
    if (!R.contentHidden && !details.has(pg.id))
      R.detail(pg.id).then((d) => {
        details.set(pg.id, d);
        const sel = cols[st.sel];
        if (!popOpen || !sel || sel.pg !== pg) return;
        const sw = pop.querySelector(".pp-swap") as HTMLElement;
        sw.innerHTML = body(pg);
        wire(pg);
        placePop(st.sel);
      });
  }
  function openAt(i: number, dir?: number) {
    hideTip();
    if (i === st.sel && popOpen && !dir) {
      close();
      return;
    }
    const c = cols[i];
    if (!c) return;
    const pg = c.pg;
    const wasOpen = popOpen;
    st.sel = i;
    if (st.kbMode) st.kb = i;
    apply();
    if (!wasOpen) {
      pop.classList.remove("glide");
      pop.innerHTML = `${head(pg, i)}<div class="pp-swap">${body(pg)}</div>${foot(pg)}`;
      wire(pg);
      placePop(i);
      void pop.offsetWidth;
      pop.classList.add("open");
      popOpen = true;
      return;
    }
    /* already open: glide to the new column and cross-fade the body in the travel direction */
    pop.classList.add("glide");
    (pop.querySelector(".pp-head") as HTMLElement).outerHTML = head(pg, i);
    const sw = pop.querySelector(".pp-swap") as HTMLElement;
    sw.style.setProperty("--dir", String(dir || 1));
    sw.classList.add("is-leaving");
    setTimeout(() => {
      sw.innerHTML = body(pg);
      const f = pop.querySelector(".pp-foot");
      if (f) f.outerHTML = foot(pg);
      sw.classList.remove("is-leaving");
      sw.classList.add("is-entering");
      wire(pg);
      placePop(i);
      requestAnimationFrame(() => requestAnimationFrame(() => sw.classList.remove("is-entering")));
    }, 110);
    placePop(i);
  }
  function step(d: number) {
    const nl = navList();
    const k = nl.indexOf(st.sel);
    const next =
      k >= 0
        ? nl[k + d]
        : d > 0
          ? nl.find((j) => j > st.sel)
          : nl
              .slice()
              .reverse()
              .find((j) => j < st.sel);
    if (next !== undefined) openAt(next, d);
  }
  function close() {
    if (!popOpen) return;
    pop.classList.remove("open", "glide");
    popOpen = false;
    st.sel = -1;
    apply();
  }
  on(document, "mousedown", (e: MouseEvent) => {
    const t = e.target as Element;
    if (!popOpen || pop.contains(t) || t.closest(".dg-col") || t.closest(".pg-lightbox")) return;
    close();
  });
  on(
    document,
    "mousedown",
    () => {
      if (st.kbMode) {
        st.kbMode = false;
        st.kb = -1;
        apply();
      }
    },
    true,
  );
  on(document, "keydown", (e: KeyboardEvent) => {
    if (frame.querySelector(".pg-lightbox")) {
      if (e.key === "Escape") closeLightbox();
      return;
    }
    if (popOpen) {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        step(1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        step(-1);
      } else if (e.key === "Escape") {
        close();
        $("dgWrap").focus();
      }
      return;
    }
    if (document.activeElement === $("dgWrap") && st.view !== "area") {
      const nl = navList();
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
        e.preventDefault();
        let k = nl.indexOf(st.kb);
        k = k < 0 ? 0 : Math.max(0, Math.min(nl.length - 1, k + (e.key === "ArrowRight" ? 1 : -1)));
        st.kbMode = true;
        st.kb = nl[k] ?? 0;
        apply();
        hover(st.kb);
      } else if (e.key === "Enter" && st.kb >= 0) {
        e.preventDefault();
        openAt(st.kb);
      }
    }
  });
  if (pane)
    on(
      pane,
      "scroll",
      () => {
        hideTip();
        if (popOpen) placePop(st.sel);
      },
      { passive: true },
    );

  /* ---------- lightbox ---------- */
  function lightbox(src: string) {
    const lb = document.createElement("div");
    lb.className = "pg-lightbox";
    lb.innerHTML = `<img alt="" src="${esc(src)}">`;
    lb.onclick = closeLightbox;
    frame.appendChild(lb);
    requestAnimationFrame(() => lb.classList.add("open"));
  }
  function closeLightbox() {
    const lb = frame.querySelector(".pg-lightbox");
    if (!lb) return;
    lb.classList.remove("open");
    setTimeout(() => lb.remove(), 200);
  }
  cleanups.push(() => frame.querySelector(".pg-lightbox")?.remove());

  /* ---------- boot ---------- */
  charts();
  h2h();
  seg();
  viewSeg();
  sortSeg();
  legend();
  build(true);
  let rT: ReturnType<typeof setTimeout> | undefined;
  on(window, "resize", () => {
    clearTimeout(rT);
    hideTip();
    rT = setTimeout(() => {
      close();
      charts();
      build(false);
    }, 120);
  });
  return () => {
    clearTimeout(rT);
    for (const c of cleanups) c();
  };
};
