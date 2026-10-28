"""Page-level Parse evaluation starter (LLM as a judge).

Pick the judge with --grader:
  comparative  (default) to compare two or more parsers. One judge call per page sees the page
               image and every provider's Markdown under blind, shuffled labels (parse_a, parse_b,
               ...). For each parse it gives a 1 to 10 score and lists its errors (severity,
               category, region type, location, description), plus tags for the page itself.
               Writes scores.jsonl and summary.json (mean score, per-page wins, ties and losses,
               pages with a high-severity error, error categories).
  diagnostic   optional, to grade one parser on its own. One judge call per
               (provider, page) lists errors, each with a severity and a category. Writes
               judgments.jsonl and summary.json (page rates with denominators and 95% CIs).
  The older names compare and severity still work.

    pip install -r requirements.txt
    export REDUCTO_API_KEY=...  OPENAI_API_KEY=...
    python parse_eval.py run --docs ./my_docs --out ./runs/h2h --providers reducto tesseract
    python parse_eval.py run --docs ./my_docs --out ./runs/solo --grader diagnostic --providers reducto

Add a vendor by writing an adapter class (see ExampleVendorAdapter) and registering it in ADAPTERS.
The tesseract adapter is a free local OCR baseline (needs the tesseract binary), handy for trying
the comparative judge before you write a real vendor adapter.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import io
import json
import math
import os
import random
import statistics
import subprocess
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Callable, Literal, Protocol, TypeVar

import pypdfium2 as pdfium
import requests
from PIL import Image

PROMPT_PATH = Path(__file__).with_name("judge_prompt.txt")
COMPARE_PROMPT_PATH = Path(__file__).with_name("compare_prompt.txt")
RENDER_DPI = 200
JUDGE_MAX_DIM_PX = 2000
MAX_BLOCKS = 80
JUDGE_ATTEMPTS = 3
SUPPORTED = {".pdf", ".png", ".jpg", ".jpeg", ".tif", ".tiff"}

Severity = Literal["not_error", "low", "medium", "high"]
CATEGORIES: list[str] = [
    "content_omission", "content_hallucination", "text_corruption", "text_duplication",
    "generation_repetition_loop", "reading_order", "table_structure", "table_content",
    "field_association_error", "checkbox_state_error", "header_footer", "watermark",
    "formatting_noise", "bad_figure_summary", "bad_chart_summary", "visual_structure_loss", "other",
]


@dataclass
class Block:
    block_id: str
    type: str
    bbox: tuple[float, float, float, float]
    content: str


@dataclass
class PageParse:
    page: int
    markdown: str
    blocks: list[Block] = field(default_factory=list)


@dataclass
class DocParse:
    provider: str
    doc: str
    status: Literal["ok", "failed"]
    pages: list[PageParse]
    latency_s: float
    cost: dict[str, object]
    settings: dict[str, object]
    error: str = ""


class Adapter(Protocol):
    name: str
    settings: dict[str, object]

    def parse(self, path: Path, out_dir: Path) -> DocParse: ...


class ReductoAdapter:
    """Reducto Parse with r-1. Docs: https://docs.reducto.ai/parse/r-1"""

    name = "reducto"
    api = os.environ.get("REDUCTO_BASE_URL", "https://platform.reducto.ai")

    def __init__(self) -> None:
        self.settings: dict[str, object] = {"settings": {"model": "r-1"}}
        self.headers = {"Authorization": f"Bearer {os.environ['REDUCTO_API_KEY']}"}

    def parse(self, path: Path, out_dir: Path) -> DocParse:
        start = time.monotonic()
        try:
            with path.open("rb") as fh:
                up = requests.post(f"{self.api}/upload", headers=self.headers, files={"file": (path.name, fh)}, timeout=600)
            up.raise_for_status()
            body = {"input": up.json()["file_id"], **self.settings}
            sub = requests.post(f"{self.api}/parse_async", headers=self.headers, json=body, timeout=120)
            sub.raise_for_status()
            job_id = sub.json()["job_id"]
            payload = self._poll(job_id)
        except (requests.RequestException, KeyError, TimeoutError) as exc:
            return DocParse(self.name, path.name, "failed", [], time.monotonic() - start, {}, self.settings, repr(exc))
        (out_dir / f"{path.stem}.reducto.json").write_text(json.dumps(payload, indent=1))
        latency = time.monotonic() - start
        if payload.get("status") != "Completed":
            return DocParse(self.name, path.name, "failed", [], latency, {"job_id": job_id}, self.settings, str(payload.get("reason") or payload.get("status")))
        result = payload["result"]
        usage = result.get("usage") or {}
        cost = {"job_id": job_id, "num_pages": usage.get("num_pages"), "credits": usage.get("credits")}
        inner = result.get("result") or {}
        cost["block_models"] = sorted({
            str((b.get("extra") or {}).get("model") or (b.get("extra") or {}).get("parse_model"))
            for c in (inner.get("chunks") or []) for b in (c.get("blocks") or [])
        })
        return DocParse(self.name, path.name, "ok", self._pages(result), latency, cost, self.settings)

    def _poll(self, job_id: str, max_wait_s: float = 1800) -> dict[str, object]:
        deadline = time.monotonic() + max_wait_s
        while time.monotonic() < deadline:
            r = requests.get(f"{self.api}/job/{job_id}", headers=self.headers, timeout=120)
            if r.status_code < 500:
                r.raise_for_status()
                payload = r.json()
                if payload.get("status") in {"Completed", "Failed"}:
                    result = payload.get("result") or {}
                    inner = result.get("result") if isinstance(result, dict) else None
                    if isinstance(inner, dict) and inner.get("type") == "url":
                        result["result"] = requests.get(inner["url"], timeout=600).json()
                    return payload
            time.sleep(3)
        raise TimeoutError(f"job {job_id} still pending after {max_wait_s}s")

    @staticmethod
    def _pages(result: dict[str, object]) -> list[PageParse]:
        inner = result.get("result") or {}
        chunks = inner.get("chunks") if isinstance(inner, dict) else inner
        by_page: dict[int, list[Block]] = defaultdict(list)
        for ci, chunk in enumerate(chunks or []):
            for bi, blk in enumerate(chunk.get("blocks") or []):
                bb = blk.get("bbox") or {}
                page = int(bb.get("page") or 1)
                by_page[page].append(Block(
                    f"chunk_{ci}:block_{bi}", str(blk.get("type")),
                    (bb.get("left", 0), bb.get("top", 0), bb.get("width", 0), bb.get("height", 0)),
                    str(blk.get("content") or ""),
                ))
        return [PageParse(p, "\n\n".join(b.content for b in blks if b.content.strip()), blks) for p, blks in sorted(by_page.items())]


class ExampleVendorAdapter:
    """Template for another vendor. Fill in parse() and keep the same output contract.

    Contract: one PageParse per source page (1-based), markdown = that page's content in reading
    order, blocks optional (used only to localize errors). Save the raw response next to the run.
    If the vendor errors or times out, return status="failed"; never drop the document.
    """

    name = "example_vendor"

    def __init__(self) -> None:
        self.settings: dict[str, object] = {"note": "record every option you set here"}

    def parse(self, path: Path, out_dir: Path) -> DocParse:
        raise NotImplementedError("Call the vendor API, save the raw JSON to out_dir, and map it to PageParse objects.")


class TesseractAdapter:
    """Local Tesseract OCR baseline: plain text per page, no layout blocks. Needs the tesseract binary."""

    name = "tesseract"

    def __init__(self) -> None:
        version = subprocess.run(["tesseract", "--version"], capture_output=True, text=True, check=True).stdout.split("\n")[0]
        self.settings: dict[str, object] = {"engine": version, "dpi": RENDER_DPI, "args": ["--psm", "3"]}

    def parse(self, path: Path, out_dir: Path) -> DocParse:
        start = time.monotonic()
        try:
            images = render(path, out_dir / f"{path.stem}.tesseract_pages")
            texts = [
                subprocess.run(["tesseract", str(img), "-", "--psm", "3"], capture_output=True, text=True, check=True, timeout=300).stdout
                for img in images
            ]
        except (OSError, subprocess.SubprocessError) as exc:
            return DocParse(self.name, path.name, "failed", [], time.monotonic() - start, {}, self.settings, repr(exc))
        (out_dir / f"{path.stem}.tesseract.json").write_text(json.dumps({"pages": texts}, indent=1))
        pages = [PageParse(i, text.strip()) for i, text in enumerate(texts, start=1)]
        return DocParse(self.name, path.name, "ok", pages, time.monotonic() - start, {"pages": len(pages)}, self.settings)


T = TypeVar("T")

ADAPTERS: dict[str, type] = {"reducto": ReductoAdapter, "tesseract": TesseractAdapter, "example_vendor": ExampleVendorAdapter}


def render(path: Path, out_dir: Path) -> list[Path]:
    out_dir.mkdir(parents=True, exist_ok=True)
    if path.suffix.lower() != ".pdf":
        img = Image.open(path)
        frames = getattr(img, "n_frames", 1)
        paths: list[Path] = []
        for i in range(frames):
            img.seek(i)
            dest = out_dir / f"{path.stem}.p{i + 1}.png"
            img.convert("RGB").save(dest)
            paths.append(dest)
        return paths
    pdf = pdfium.PdfDocument(str(path))
    paths = []
    for i in range(len(pdf)):
        dest = out_dir / f"{path.stem}.p{i + 1}.png"
        pdf[i].render(scale=RENDER_DPI / 72).to_pil().convert("RGB").save(dest)
        paths.append(dest)
    return paths


def judge_schema() -> dict[str, object]:
    error_props: dict[str, object] = {
        "error": {"type": "string"},
        "severity": {"type": "string", "enum": ["not_error", "low", "medium", "high"]},
        "category": {"type": "string", "enum": CATEGORIES},
        "visual_region_type": {"type": "string"},
        "location_hint": {"type": "string"},
        "likely_source": {"type": "string"},
        "geometry_caused_error": {"type": "boolean"},
        "geometry_issue": {"type": "string"},
        "involved_block_ids": {"type": "array", "items": {"type": "string"}},
        "reasoning": {"type": "string"},
    }
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["page_features", "errors"],
        "properties": {
            "page_features": {"type": "array", "items": {"type": "string"}},
            "errors": {"type": "array", "items": {
                "type": "object", "additionalProperties": False,
                "required": list(error_props), "properties": error_props,
            }},
        },
    }


def block_manifest(blocks: list[Block]) -> str:
    if not blocks:
        return ""
    lines = [
        "## Provider layout blocks",
        "Each block has an id, type, normalized bbox, and text preview. "
        "Use these IDs exactly in involved_block_ids when localizing errors.",
    ]
    for b in blocks[:MAX_BLOCKS]:
        text = " ".join(b.content.split())[:220]
        lines.append(f"- {b.block_id} | type={b.type} | bbox=({b.bbox[0]},{b.bbox[1]},{b.bbox[2]},{b.bbox[3]}) | text={text!r}")
    if len(blocks) > MAX_BLOCKS:
        lines.append(f"- ... {len(blocks) - MAX_BLOCKS} additional blocks omitted")
    return "\n".join(lines)


def image_data_url(path: Path) -> str:
    img = Image.open(path).convert("RGB")
    if max(img.size) > JUDGE_MAX_DIM_PX:
        img.thumbnail((JUDGE_MAX_DIM_PX, JUDGE_MAX_DIM_PX))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


def judge_page(image: Path, page: PageParse, model: str, effort: str) -> dict[str, object]:
    from openai import OpenAI, OpenAIError

    template = PROMPT_PATH.read_text()
    prompt = template.replace("{block_manifest_section}", block_manifest(page.blocks)).replace("{markdown}", page.markdown)
    client = OpenAI()
    last = ""
    for attempt in range(1, JUDGE_ATTEMPTS + 1):
        start = time.monotonic()
        try:
            resp = client.chat.completions.create(
                model=model,
                reasoning_effort=effort,
                response_format={"type": "json_schema", "json_schema": {"name": "DiagnosticResponse", "strict": True, "schema": judge_schema()}},
                messages=[{"role": "user", "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": image_data_url(image), "detail": "high"}},
                ]}],
            )
            parsed = json.loads(resp.choices[0].message.content or "")
            if not isinstance(parsed.get("errors"), list):
                raise ValueError("missing errors list")
            usage = resp.usage.model_dump() if resp.usage else {}
            return {"status": "ok", "attempts": attempt, "latency_s": round(time.monotonic() - start, 2), "usage": usage, **parsed}
        except (OpenAIError, ValueError, json.JSONDecodeError) as exc:
            last = repr(exc)
            time.sleep(2 * attempt)
    return {"status": "failed", "attempts": JUDGE_ATTEMPTS, "error": last, "errors": [], "page_features": []}


COMPARE_SEVERITIES = ["low", "medium", "high"]


def compare_schema() -> dict[str, object]:
    error: dict[str, object] = {
        "severity": {"type": "string", "enum": COMPARE_SEVERITIES},
        "category": {"type": "string", "enum": CATEGORIES},
        "visual_region_type": {"type": "string", "description": "Short region type, such as table, form field or heading."},
        "location_hint": {"type": "string", "description": "Where on the page: section, field label, table row and column, or nearby text."},
        "description": {"type": "string", "description": "One specific sentence; quote the page text and what the parse wrote."},
    }
    evaluation: dict[str, object] = {
        "label": {"type": "string", "description": "Blinded parse label, such as parse_a."},
        "errors": {"type": "array", "items": {"type": "object", "additionalProperties": False, "required": list(error), "properties": error}},
        "reasoning": {"type": "string", "description": "One to two sentence rationale before scoring."},
        "score": {"type": "integer", "description": "Quality score from 1 to 10 inclusive."},
    }
    return {
        "type": "object",
        "additionalProperties": False,
        "required": ["page_features", "evaluations"],
        "properties": {
            "page_features": {"type": "array", "items": {"type": "string"}, "description": "Short tags for the page itself, such as table, form or handwriting."},
            "evaluations": {"type": "array", "items": {
                "type": "object", "additionalProperties": False,
                "required": list(evaluation), "properties": evaluation,
            }},
        },
    }


def stable_seed(value: str) -> int:
    return int.from_bytes(hashlib.sha256(value.encode("utf-8")).digest()[:8], "big")


def label_map(providers: list[str], sample_id: str) -> dict[str, str]:
    """Blind labels for one page: parse_a, parse_b, ... in an order shuffled by a seed from the page id."""
    order = list(providers)
    random.Random(stable_seed(sample_id)).shuffle(order)
    return {f"parse_{chr(ord('a') + i)}": provider for i, provider in enumerate(order)}


def build_compare_prompt(parses_by_label: dict[str, str]) -> str:
    sections = [f"## {label}\n\n````text\n{content}\n````" for label, content in parses_by_label.items()]
    return COMPARE_PROMPT_PATH.read_text().format(parse_sections="\n\n".join(sections), labels=", ".join(parses_by_label))


def judge_compare(image: Path, parses_by_label: dict[str, str], model: str, effort: str) -> dict[str, object]:
    from openai import OpenAI, OpenAIError

    prompt = build_compare_prompt(parses_by_label)
    client = OpenAI()
    last = ""
    for attempt in range(1, JUDGE_ATTEMPTS + 1):
        start = time.monotonic()
        try:
            resp = client.chat.completions.create(
                model=model,
                reasoning_effort=effort,
                response_format={"type": "json_schema", "json_schema": {"name": "JudgeResponse", "strict": True, "schema": compare_schema()}},
                messages=[{"role": "user", "content": [
                    {"type": "text", "text": prompt},
                    {"type": "image_url", "image_url": {"url": image_data_url(image), "detail": "high"}},
                ]}],
            )
            answer = json.loads(resp.choices[0].message.content or "")
            evaluations, features = answer["evaluations"], [str(f) for f in answer["page_features"]]
            labels = [e["label"] for e in evaluations]
            if sorted(labels) != sorted(parses_by_label):
                raise ValueError(f"expected one evaluation per label {sorted(parses_by_label)}, got {labels}")
            if any(not isinstance(e["score"], int) or not 1 <= e["score"] <= 10 for e in evaluations):
                raise ValueError("score outside 1 to 10")
            usage = resp.usage.model_dump() if resp.usage else {}
            return {"status": "ok", "attempts": attempt, "latency_s": round(time.monotonic() - start, 2), "usage": usage,
                    "page_features": features, "evaluations": evaluations}
        except (OpenAIError, ValueError, KeyError, TypeError, json.JSONDecodeError) as exc:
            last = repr(exc)
            time.sleep(2 * attempt)
    return {"status": "failed", "attempts": JUDGE_ATTEMPTS, "error": last, "page_features": [], "evaluations": []}


def summarize_compare(records: list[dict[str, object]], providers: list[str], page_types: dict[str, str]) -> dict[str, object]:
    scored = [r for r in records if r["judge_status"] == "ok"]
    out: dict[str, object] = {
        "grader": "comparative", "pages_total": len(records), "pages_scored": len(scored),
        "judge_failed_pages": len(records) - len(scored), "providers": {},
    }
    for p in providers:
        mine = [r["scores"][p]["score"] for r in scored]
        h2h: dict[str, dict[str, int]] = {}
        for q in providers:
            if q == p:
                continue
            diffs = [r["scores"][p]["score"] - r["scores"][q]["score"] for r in scored]
            h2h[q] = {"wins": sum(d > 0 for d in diffs), "ties": sum(d == 0 for d in diffs), "losses": sum(d < 0 for d in diffs)}
        by_type: dict[str, dict[str, object]] = {}
        for t in sorted({page_types.get(str(r["sample_id"]), "unlabeled") for r in scored}):
            sub = [r["scores"][p]["score"] for r in scored if page_types.get(str(r["sample_id"]), "unlabeled") == t]
            by_type[t] = {"mean_score": round(statistics.mean(sub), 2), "pages": len(sub)}
        errors = [e for r in scored for e in r["scores"][p]["errors"]]
        sev = [Counter(e["severity"] for e in r["scores"][p]["errors"]) for r in scored]
        out["providers"][p] = {
            "mean_score": round(statistics.mean(mine), 2) if mine else None,
            "median_score": statistics.median(mine) if mine else None,
            "head_to_head": h2h,
            "pct_pages_high": rate(sum(1 for s in sev if s["high"]), len(scored)),
            "pct_pages_high_or_medium": rate(sum(1 for s in sev if s["high"] or s["medium"]), len(scored)),
            "error_counts": {k: sum(s[k] for s in sev) for k in COMPARE_SEVERITIES[::-1]},
            "categories": dict(Counter(f"{e['category']}:{e['severity']}" for e in errors).most_common()),
            "by_page_type": by_type,
            "parse_failed_pages": sum(1 for r in records if r["parse_status"][p] != "ok"),
            "empty_markdown_pages": sum(1 for r in scored if r["scores"][p]["empty_markdown"]),
        }
    return out


def wilson(k: int, n: int, z: float = 1.96) -> tuple[float, float]:
    if n == 0:
        return (0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    c = (p + z * z / (2 * n)) / d
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d
    return (max(0.0, c - h), min(1.0, c + h))


def rate(k: int, n: int) -> dict[str, object]:
    lo, hi = wilson(k, n)
    return {"pages": k, "of": n, "pct": round(100 * k / n, 1) if n else None, "ci95": [round(100 * lo, 1), round(100 * hi, 1)]}


def summarize(records: list[dict[str, object]], page_types: dict[str, str]) -> dict[str, object]:
    by_provider: dict[str, list[dict[str, object]]] = defaultdict(list)
    for r in records:
        by_provider[str(r["provider"])].append(r)
    ok_sets = [{r["sample_id"] for r in rs if r["parse_status"] == "ok" and r["judge_status"] == "ok"} for rs in by_provider.values()]
    shared = set.intersection(*ok_sets) if ok_sets else set()
    out: dict[str, object] = {"shared_pages": len(shared), "providers": {}}
    for provider, rs in by_provider.items():
        scored = [r for r in rs if r["sample_id"] in shared]
        sev = [Counter(e["severity"] for e in r["errors"]) for r in scored]
        n = len(scored)
        cats: Counter[str] = Counter()
        for r in scored:
            for e in r["errors"]:
                if e["severity"] != "not_error":
                    cats[f"{e['category']}:{e['severity']}"] += 1
        by_type: dict[str, dict[str, object]] = {}
        for t in sorted({page_types.get(str(r["sample_id"]), "unlabeled") for r in scored}):
            sub = [s for r, s in zip(scored, sev) if page_types.get(str(r["sample_id"]), "unlabeled") == t]
            by_type[t] = {"high": rate(sum(1 for s in sub if s["high"]), len(sub)), "high_or_medium": rate(sum(1 for s in sub if s["high"] or s["medium"]), len(sub))}
        parse_failed = sum(1 for r in rs if r["parse_status"] != "ok")
        judge_failed = sum(1 for r in rs if r["parse_status"] == "ok" and r["judge_status"] != "ok")
        out["providers"][provider] = {
            "pct_pages_high": rate(sum(1 for s in sev if s["high"]), n),
            "pct_pages_high_or_medium": rate(sum(1 for s in sev if s["high"] or s["medium"]), n),
            "pct_pages_any_error": rate(sum(1 for s in sev if s["high"] or s["medium"] or s["low"]), n),
            "pct_pages_high_counting_parse_failures": rate(sum(1 for s in sev if s["high"]) + parse_failed, n + parse_failed),
            "error_counts": {k: sum(s[k] for s in sev) for k in ("high", "medium", "low")},
            "categories": dict(cats.most_common()),
            "by_page_type": by_type,
            "pages_total": len(rs),
            "parse_failed_pages": parse_failed,
            "judge_failed_pages": judge_failed,
        }
    return out


def percentile(values: list[float], q: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return round(ordered[min(len(ordered) - 1, max(0, math.ceil(q * len(ordered)) - 1))], 1)


def cost_latency_summary(parses: list[DocParse]) -> dict[str, object]:
    latencies = [p.latency_s for p in parses if p.status == "ok"]
    credits = [c for p in parses if isinstance(c := p.cost.get("credits"), (int, float))]
    pages = [n for p in parses if isinstance(n := p.cost.get("num_pages"), int)]
    return {"latency_s_per_doc_p50": percentile(latencies, 0.5), "latency_s_per_doc_p95": percentile(latencies, 0.95),
            "credits_total": sum(credits) if credits else None, "pages_billed": sum(pages) if pages else None,
            "per_doc": [{"doc": p.doc, "status": p.status, "latency_s": round(p.latency_s, 1), **p.cost} for p in parses]}


def judge_all(work: Callable[[T], dict[str, object]], tasks: list[T], workers: int) -> list[dict[str, object]]:
    records: list[dict[str, object]] = []
    with ThreadPoolExecutor(workers) as pool:
        for k, record in enumerate(pool.map(work, tasks), start=1):
            records.append(record)
            if k == len(tasks) or k % 10 == 0:
                print(f"judged {k}/{len(tasks)}", flush=True)
    return records


def judge_usage(records: list[dict[str, object]]) -> dict[str, int]:
    totals: Counter[str] = Counter()
    for r in records:
        for key, value in (r.get("usage") or {}).items():
            if isinstance(value, int):
                totals[key] += value
    return dict(totals)


def run(args: argparse.Namespace) -> None:
    out = Path(args.out)
    (out / "raw").mkdir(parents=True, exist_ok=True)
    docs = sorted(p for p in Path(args.docs).iterdir() if p.suffix.lower() in SUPPORTED)
    page_types = json.loads(Path(args.page_types).read_text()) if args.page_types else {}
    images = {d.name: render(d, out / "pages") for d in docs}
    adapters = [ADAPTERS[name]() for name in args.providers]
    prompt_file = COMPARE_PROMPT_PATH if args.grader == "comparative" else PROMPT_PATH
    schema = compare_schema() if args.grader == "comparative" else judge_schema()
    judge = {"grader": args.grader, "model": args.judge_model, "reasoning_effort": args.reasoning_effort, "prompt_file": prompt_file.name,
             "prompt_sha256": hashlib.sha256(prompt_file.read_bytes()).hexdigest(), "prompt": prompt_file.read_text(), "schema": schema}
    run_info = {"run_date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "seed": args.seed, "providers": list(args.providers),
                "docs": [d.name for d in docs]}
    (out / "settings.json").write_text(json.dumps({"run": run_info} | {a.name: a.settings for a in adapters} | {"judge": judge}, indent=1))

    parses: list[DocParse] = []
    with ThreadPoolExecutor(args.workers) as pool:
        for dp in pool.map(lambda job: job[0].parse(job[1], out / "raw"), [(a, d) for a in adapters for d in docs]):
            print(f"parsed {dp.provider} {dp.doc}: {dp.status} {dp.latency_s:.1f}s {dp.error}", flush=True)
            parses.append(dp)
    (out / "parses.jsonl").write_text("".join(json.dumps(asdict(p)) + "\n" for p in parses))
    cost_latency = {a.name: cost_latency_summary([p for p in parses if p.provider == a.name]) for a in adapters}
    if args.grader == "comparative":
        run_compare(args, out, parses, images, page_types, cost_latency)
    else:
        run_severity(args, out, parses, images, page_types, cost_latency)


def run_compare(args: argparse.Namespace, out: Path, parses: list[DocParse], images: dict[str, list[Path]],
                page_types: dict[str, str], cost_latency: dict[str, object]) -> None:
    providers = list(args.providers)
    by_doc: dict[str, dict[str, DocParse]] = defaultdict(dict)
    for dp in parses:
        by_doc[dp.doc][dp.provider] = dp
    tasks = [(doc, i, img) for doc, imgs in images.items() for i, img in enumerate(imgs, start=1)]
    random.Random(args.seed).shuffle(tasks)

    def work(t: tuple[str, int, Path]) -> dict[str, object]:
        doc, i, img = t
        sample_id = f"{doc}#p{i}"
        markdown: dict[str, str] = {}
        status: dict[str, str] = {}
        for p in providers:
            dp = by_doc[doc][p]
            status[p] = dp.status
            page = next((pg for pg in dp.pages if pg.page == i), None) if dp.status == "ok" else None
            markdown[p] = page.markdown if page else ""
        labels = label_map(providers, sample_id)
        verdict = judge_compare(img, {label: markdown[p] for label, p in labels.items()}, args.judge_model, args.reasoning_effort)
        scores = {
            labels[e["label"]]: {"label": e["label"], "score": e["score"], "reasoning": e["reasoning"], "errors": e["errors"],
                                 "markdown_chars": len(markdown[labels[e["label"]]]), "empty_markdown": not markdown[labels[e["label"]]].strip()}
            for e in verdict.pop("evaluations")
        }
        return {"sample_id": sample_id, "doc": doc, "page": i, "image": str(img.relative_to(out)), "label_to_provider": labels,
                "parse_status": status, "judge_status": verdict.pop("status"), "scores": scores, **verdict}

    records = judge_all(work, tasks, args.workers)
    records.sort(key=lambda r: (r["doc"], r["page"]))
    (out / "scores.jsonl").write_text("".join(json.dumps(r) + "\n" for r in records))
    summary = summarize_compare(records, providers, page_types)
    summary["parse_cost_latency"] = cost_latency
    summary["judge_usage"] = judge_usage(records)
    (out / "summary.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps({p: {m: v[m] for m in ("mean_score", "head_to_head", "pct_pages_high", "parse_failed_pages")} for p, v in summary["providers"].items()}
                     | {"judge_failed_pages": summary["judge_failed_pages"]}, indent=1))


def run_severity(args: argparse.Namespace, out: Path, parses: list[DocParse], images: dict[str, list[Path]],
                 page_types: dict[str, str], cost_latency: dict[str, object]) -> None:
    tasks: list[tuple[DocParse, int, Path, PageParse | None]] = []
    for dp in parses:
        pages = {p.page: p for p in dp.pages}
        for i, img in enumerate(images[dp.doc], start=1):
            tasks.append((dp, i, img, pages.get(i, PageParse(i, "")) if dp.status == "ok" else None))
    random.Random(args.seed).shuffle(tasks)

    def work(t: tuple[DocParse, int, Path, PageParse | None]) -> dict[str, object]:
        dp, i, img, page = t
        base = {"provider": dp.provider, "doc": dp.doc, "page": i, "sample_id": f"{dp.doc}#p{i}", "image": str(img.relative_to(out))}
        if page is None:
            return base | {"parse_status": "failed", "judge_status": "skipped", "errors": [], "markdown": ""}
        verdict = judge_page(img, page, args.judge_model, args.reasoning_effort)
        return base | {"parse_status": "ok", "judge_status": verdict.pop("status"), "markdown": page.markdown, **verdict}

    records = judge_all(work, tasks, args.workers)
    records.sort(key=lambda r: (r["provider"], r["doc"], r["page"]))
    (out / "judgments.jsonl").write_text("".join(json.dumps(r) + "\n" for r in records))
    summary = summarize(records, page_types)
    summary["parse_cost_latency"] = cost_latency
    summary["judge_usage"] = judge_usage(records)
    (out / "summary.json").write_text(json.dumps(summary, indent=1))
    print(json.dumps({k: {m: v[m] for m in ("pct_pages_high", "pct_pages_high_or_medium", "parse_failed_pages", "judge_failed_pages")} for k, v in summary["providers"].items()}, indent=1))


GRADER_ALIASES = {"compare": "comparative", "severity": "diagnostic"}


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run", help="render, parse, judge and summarize")
    r.add_argument("--docs", required=True, help="folder of PDFs or images")
    r.add_argument("--out", required=True)
    r.add_argument("--grader", choices=["comparative", "diagnostic", "compare", "severity"], default="comparative",
                   help="comparative (default): two or more parsers head to head, a 1 to 10 score and structured errors per parse. diagnostic: one parser on its own, errors by severity")
    r.add_argument("--providers", nargs="+", required=True, choices=sorted(ADAPTERS))
    r.add_argument("--page-types", help="optional JSON mapping sample_id (file.pdf#p3) to a page type label")
    r.add_argument("--judge-model", default=os.environ.get("JUDGE_MODEL", "gpt-6-astra"))
    r.add_argument("--reasoning-effort", default="medium")
    r.add_argument("--workers", type=int, default=4)
    r.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    args.grader = GRADER_ALIASES.get(args.grader, args.grader)
    if args.grader == "comparative" and len(set(args.providers)) < 2:
        ap.error("--grader comparative needs two or more --providers (for example reducto tesseract); use --grader diagnostic for one parser")
    run(args)


if __name__ == "__main__":
    main()
