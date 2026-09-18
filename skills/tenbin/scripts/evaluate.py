#!/usr/bin/env python3
"""Call the TypeSafe System One API without the MCP server or an SDK (stdlib only).

One state, all questions (the same JSON `lint_questions.py` takes; `model` optional):

    python evaluate.py request.json [--repeat N]

Many states, same questions, optional labels -> per-question stats and accuracy per band:

    python evaluate.py questions.json --rows rows.jsonl [--repeat N] [--concurrency N] [--out results.jsonl]

rows.jsonl: one JSON object per line, {"state": ..., "labels": {"<question id>": <expected>}}.
Labels are optional; expected is the option name (Choice), the level index (Score) or a
boolean / 1 / 0 / yes / no (Noul). Band = confidence (Choice, Score) or |noul - 0.5| * 2.

Key: TYPESAFE_API_KEY, or the TYPESAFE_API_KEY= line of ~/.config/tenbin/env (--env-file).
Never printed. Lint runs first and errors block the call, as the MCP tool does. The API limits
(64k tokens per call, 32k state + longest question) are enforced before sending, plus
--budget-tokens per run. With --repeat > 1 each call carries a distinct `sample_uid` (object
states get the field, other states are wrapped as {content, sample_uid}) so repeats are
independent trials, as tenbin_evaluate_many and the self-consistency cookbooks do.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import statistics
import sys
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lint_questions import lint  # noqa: E402

DEFAULT_BASE_URL = "https://api.typesafe.ai"
DEFAULT_ENV_FILE = Path.home() / ".config" / "tenbin" / "env"
PRICE_PER_MTOK_USD = 0.042
TOTAL_TOKENS = 64_000
STATE_AND_LONGEST = 32_000
MAX_ATTEMPTS = 5
MAX_RETRY_WAIT_S = 60.0  # the official SDKs cap Retry-After at 60 s
RETRY_STATUSES = {408, 429, 529}  # plus every 5xx, as the official SDK retry policy
TRUE_LABELS = {"1", "true", "yes", "y"}


class ApiError(Exception):
    def __init__(self, status: int, body: str, request_id: str | None):
        super().__init__(f"HTTP {status}")
        self.status, self.body, self.request_id = status, body, request_id


def read_env_file(path: Path) -> dict[str, str]:
    out: dict[str, str] = {}
    if not path.is_file():
        return out
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        out[k.strip()] = v.strip().strip("'\"")
    return out


def tokens(v: Any) -> int:
    return math.ceil(len(json.dumps(v, ensure_ascii=False, separators=(",", ":"))) / 4)


def estimate(state: Any, questions: dict[str, Any]) -> tuple[int, int, int]:
    s = tokens(state)
    per_q = [tokens(q) for q in questions.values()]
    return s, sum(per_q), max(per_q, default=0)


class Client:
    def __init__(self, api_key: str, model: str, base_url: str, budget_tokens: int):
        self.api_key, self.model, self.base_url = api_key, model, base_url.rstrip("/")
        self.budget_tokens = budget_tokens
        self.calls = self.failures = self.input_tokens = self.output_tokens = 0

    def system_one(self, state: Any, questions: dict[str, Any]) -> dict[str, Any]:
        s, q, longest = estimate(state, questions)
        if s + q > TOTAL_TOKENS:
            raise ValueError(f"estimated {s + q} input tokens exceeds the per-call limit of {TOTAL_TOKENS}; trim the state")
        if s + longest > STATE_AND_LONGEST:
            raise ValueError(f"estimated state ({s}) + longest question ({longest}) exceeds the API limit of {STATE_AND_LONGEST}")
        if self.input_tokens + self.output_tokens + s + q > self.budget_tokens:
            raise ValueError(f"run budget of {self.budget_tokens} tokens would be exceeded; raise --budget-tokens")
        body = json.dumps({"state": state, "model": self.model, "questions": questions}).encode("utf-8")
        req = urllib.request.Request(
            f"{self.base_url}/v1/systemone",
            data=body,
            method="POST",
            headers={"Authorization": f"Bearer {self.api_key}", "Content-Type": "application/json"},
        )
        started = time.monotonic()
        self.calls += 1
        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                with urllib.request.urlopen(req, timeout=60) as resp:
                    data = json.loads(resp.read().decode("utf-8"))
                    request_id = resp.headers.get("x-typesafe-request-id")
                    break
            except urllib.error.HTTPError as e:
                status, text = e.code, e.read().decode("utf-8", "replace")
                request_id = e.headers.get("x-typesafe-request-id")
                if status in RETRY_STATUSES or status >= 500:
                    if attempt < MAX_ATTEMPTS:
                        time.sleep(retry_wait(e.headers, attempt))
                        continue
                self.failures += 1
                raise ApiError(status, text, request_id) from None
            except urllib.error.URLError as e:
                if attempt < MAX_ATTEMPTS:
                    time.sleep(min(2 ** attempt, 30))
                    continue
                self.failures += 1
                raise RuntimeError(f"could not reach {self.base_url}: {e.reason}") from None
        usage = data.get("usage") or {}
        self.input_tokens += usage.get("input_tokens", 0)
        self.output_tokens += usage.get("output_tokens", 0)
        return {
            "model": data.get("model"),
            "answers": data["answers"],
            "usage": usage,
            "cost_usd": usage.get("input_tokens", 0) * PRICE_PER_MTOK_USD / 1e6,
            "request_id": request_id,
            "latency_ms": round((time.monotonic() - started) * 1000),
        }

    def stats(self) -> dict[str, Any]:
        return {
            "calls": self.calls,
            "failures": self.failures,
            "input_tokens": self.input_tokens,
            "output_tokens": self.output_tokens,
            "cost_usd": round(self.input_tokens * PRICE_PER_MTOK_USD / 1e6, 6),
        }


def retry_wait(headers: Any, attempt: int) -> float:
    """Seconds to wait: `retry-after-ms`, then `retry-after` (seconds), else exponential backoff; capped."""
    ms = headers.get("retry-after-ms")
    if ms and ms.strip().isdigit():
        return min(int(ms) / 1000, MAX_RETRY_WAIT_S)
    s = headers.get("retry-after")
    if s and s.strip().isdigit():
        return min(float(s), MAX_RETRY_WAIT_S)
    return min(2 ** attempt, 30)


def with_sample_uid(state: Any, uid: str) -> Any:
    """A distinct uid per repeat so repeated evaluations are independent trials (mirrors tenbin_evaluate_many)."""
    if isinstance(state, dict):
        return {**state, "sample_uid": uid}
    return {"content": state, "sample_uid": uid}


def describe(err: Exception) -> str:
    if isinstance(err, ApiError):
        rid = f" (request {err.request_id})" if err.request_id else ""
        if err.status == 401:
            return f"TypeSafe rejected the API key (401){rid}. Check TYPESAFE_API_KEY."
        if err.status == 422:
            return f"TypeSafe rejected the request body (422){rid}: {err.body}. Run lint_questions.py on the same questions."
        if err.status == 429:
            return f"Rate limited (429) after {MAX_ATTEMPTS} attempts{rid}. Lower --concurrency."
        return f"TypeSafe API error {err.status}{rid}: {err.body[:300]}"
    return str(err)


def band_of(x: float, edges: list[float]) -> str:
    lo = 0.0
    for e in edges:
        if x < e:
            return f"[{lo:.2f},{e:.2f})"
        lo = e
    return f"[{lo:.2f},1.00]"


def judge(qtype: str, ans: dict[str, Any], expected: Any) -> tuple[bool, float, float]:
    """-> (correct, band value, signal used for repeat spread)."""
    if qtype == "choice":
        return ans["choice"] == str(expected), ans["confidence"], ans["probabilities"].get(ans["choice"], 0.0)
    if qtype == "score":
        return round(ans["score"]) == int(expected), ans["confidence"], ans["score"]
    truth = expected if isinstance(expected, bool) else str(expected).strip().lower() in TRUE_LABELS
    return (ans["noul"] > 0.5) == truth, abs(ans["noul"] - 0.5) * 2, ans["noul"]


def signal_of(qtype: str, ans: dict[str, Any]) -> float:
    if qtype == "choice":
        return ans["probabilities"].get(ans["choice"], 0.0)
    return ans["score"] if qtype == "score" else ans["noul"]


def run_lint(questions: dict[str, Any], state: Any) -> None:
    r = lint(questions, state)
    for w in r["warnings"]:
        print(f"lint warning  {w['question_id']}: {w['message']}", file=sys.stderr)
    if r["errors"]:
        for e in r["errors"]:
            print(f"lint error    {e['question_id']}: {e['message']} -> {e['fix']}", file=sys.stderr)
        sys.exit(2)


def run_single(client: Client, state: Any, questions: dict[str, Any], repeat: int) -> None:
    results = [client.system_one(with_sample_uid(state, f"s{i}") if repeat > 1 else state, questions) for i in range(repeat)]
    out: dict[str, Any] = results[0] if repeat == 1 else {"runs": results}
    if repeat > 1:
        spread = {}
        for qid, q in questions.items():
            sig = [signal_of(q["type"], r["answers"][qid]) for r in results]
            spread[qid] = {"mean": round(statistics.mean(sig), 4), "std": round(statistics.pstdev(sig), 4)}
            if q["type"] == "choice":
                spread[qid]["choices"] = dict(Counter(r["answers"][qid]["choice"] for r in results))
        out["repeat_spread"] = spread
    out["session"] = client.stats()
    print(json.dumps(out, ensure_ascii=False, indent=2))


def run_rows(client: Client, questions: dict[str, Any], rows: list[dict[str, Any]], args: argparse.Namespace) -> None:
    edges = [float(x) for x in args.bands.split(",")]
    qtypes = {qid: q["type"] for qid, q in questions.items()}
    stop = {"fatal": False}

    def one(i: int, row: dict[str, Any]) -> dict[str, Any]:
        if stop["fatal"]:
            return {"row": i, "status": "skipped"}
        runs = []
        for k in range(args.repeat):
            try:
                runs.append(client.system_one(with_sample_uid(row["state"], f"r{i}s{k}") if args.repeat > 1 else row["state"], questions))
            except ApiError as e:
                if e.status in (401, 403):
                    stop["fatal"] = True
                return {"row": i, "status": "failed", "error": describe(e)}
            except (ValueError, RuntimeError) as e:
                return {"row": i, "status": "failed", "error": describe(e)}
        return {"row": i, "status": "ok", "labels": row.get("labels"), "runs": runs}

    with ThreadPoolExecutor(max_workers=args.concurrency) as pool:
        results = list(pool.map(lambda ir: one(*ir), enumerate(rows)))

    if args.out:
        with open(args.out, "w", encoding="utf-8") as fh:
            for r in results:
                fh.write(json.dumps(r, ensure_ascii=False) + "\n")

    ok = [r for r in results if r["status"] == "ok"]
    n_fail = sum(r["status"] == "failed" for r in results)
    n_skip = sum(r["status"] == "skipped" for r in results)
    print(f"rows {len(rows)}  ok {len(ok)}  failed {n_fail}  skipped {n_skip}  repeat {args.repeat}  model {client.model}")
    for r in results:
        if r["status"] == "failed":
            print(f"  row {r['row']}: {r['error']}")

    for qid, qtype in qtypes.items():
        signals = [signal_of(qtype, run["answers"][qid]) for r in ok for run in r["runs"]]
        if not signals:
            continue
        line = f"{qid} ({qtype}): mean {statistics.mean(signals):.3f}"
        if len(signals) > 1:
            line += f", std {statistics.pstdev(signals):.3f}"
        if qtype == "choice":
            hist = Counter(run["answers"][qid]["choice"] for r in ok for run in r["runs"])
            line += "  " + ", ".join(f"{k} {v}" for k, v in hist.most_common())
        if args.repeat > 1:
            spreads = [statistics.pstdev([signal_of(qtype, run["answers"][qid]) for run in r["runs"]]) for r in ok]
            line += f"  repeat spread mean {statistics.mean(spreads):.3f} max {max(spreads):.3f}"
        print(line)

        labelled = [r for r in ok if r.get("labels") and qid in r["labels"]]
        if not labelled:
            continue
        per_band: dict[str, list[bool]] = defaultdict(list)
        for r in labelled:
            for run in r["runs"]:
                correct, band_value, _ = judge(qtype, run["answers"][qid], r["labels"][qid])
                per_band[band_of(band_value, edges)].append(correct)
        total = sum(len(v) for v in per_band.values())
        print(f"  {'band':>14} {'rows':>5} {'share':>6} {'accuracy':>9}")
        for band in sorted(per_band):
            hits = per_band[band]
            few = "   (few rows)" if len(hits) < 20 else ""
            print(f"  {band:>14} {len(hits):>5} {len(hits)/total:>6.0%} {sum(hits)/len(hits):>9.0%}{few}")
        if len(labelled) < 20:
            print("  fewer than 20 labelled rows: bands are unreliable, thresholds stay provisional")
    print("session " + json.dumps(client.stats()))


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("request", help="JSON with questions (and state for single mode)")
    ap.add_argument("--rows", help="JSONL of {state, labels?}; enables many-state mode")
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument("--model")
    ap.add_argument("--bands", default="0.5,0.6,0.7,0.8,0.9")
    ap.add_argument("--out", help="write per-row raw results as JSONL")
    ap.add_argument("--max-rows", type=int, default=500)
    ap.add_argument("--budget-tokens", type=int, default=20_000_000)
    ap.add_argument("--env-file", default=str(DEFAULT_ENV_FILE))
    ap.add_argument("--base-url", default=os.environ.get("TYPESAFE_BASE_URL", DEFAULT_BASE_URL))
    args = ap.parse_args()

    env = read_env_file(Path(args.env_file).expanduser())
    api_key = (os.environ.get("TYPESAFE_API_KEY") or env.get("TYPESAFE_API_KEY") or "").strip()
    if not api_key:
        sys.exit(f"TYPESAFE_API_KEY is not set (env or {args.env_file}). Create a key at https://console.typesafe.ai/settings/keys.")
    model = args.model or os.environ.get("TYPESAFE_DEFAULT_MODEL") or env.get("TYPESAFE_DEFAULT_MODEL") or "jev-latest"

    with open(args.request, encoding="utf-8") as fh:
        doc = json.load(fh)
    questions = doc["questions"]
    client = Client(api_key, doc.get("model") or model, args.base_url, args.budget_tokens)

    try:
        if args.rows:
            with open(args.rows, encoding="utf-8") as fh:
                rows = [json.loads(line) for line in fh if line.strip()]
            if len(rows) > args.max_rows:
                sys.exit(f"{len(rows)} rows exceeds --max-rows {args.max_rows}; split the file")
            run_lint(questions, rows[0]["state"] if rows else None)
            run_rows(client, questions, rows, args)
        else:
            run_lint(questions, doc.get("state"))
            run_single(client, doc["state"], questions, args.repeat)
    except (ApiError, ValueError, RuntimeError) as e:
        sys.exit(describe(e))


if __name__ == "__main__":
    main()
