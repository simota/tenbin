#!/usr/bin/env python3
"""Run labelled rows through your questions and print accuracy per confidence band.

    python eval_thresholds.py labelled.csv --state-col text --label-col category \
        --question category [--repeat 2] [--bands 0.5,0.6,0.7,0.8,0.9]

- labelled.csv: one row per input; --state-col is sent as {"text": ...} (or use --state-json
  when the column already holds a JSON object); --label-col holds the expected answer.
- --question: the id in QUESTIONS to evaluate. Choice: accuracy = choice == label,
  band = confidence. Score: accuracy = round(score) == int(label), band = confidence.
  Noul: accuracy = (noul > 0.5) == (label in {1,true,yes}), band = |noul - 0.5| * 2.
Requires TYPESAFE_API_KEY. Uses questions.py next to this file.
"""
from __future__ import annotations

import argparse
import csv
import json
import statistics
from collections import defaultdict

from typesafe_sdk import TypeSafeClient

from questions import MODEL, QUESTIONS

TRUE_LABELS = {"1", "true", "yes", "y"}


def band_of(x: float, edges: list[float]) -> str:
    lo = 0.0
    for e in edges:
        if x < e:
            return f"[{lo:.2f},{e:.2f})"
        lo = e
    return f"[{lo:.2f},1.00]"


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("csv")
    ap.add_argument("--state-col", required=True)
    ap.add_argument("--state-json", action="store_true", help="state column holds a JSON object")
    ap.add_argument("--label-col", required=True)
    ap.add_argument("--question", required=True)
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--bands", default="0.5,0.6,0.7,0.8,0.9")
    args = ap.parse_args()

    edges = [float(x) for x in args.bands.split(",")]
    q = QUESTIONS[args.question]
    qtype = getattr(q, "type", None) or type(q).__name__.lower()

    with open(args.csv, newline="", encoding="utf-8") as fh:
        rows = list(csv.DictReader(fh))

    per_band: dict[str, list[bool]] = defaultdict(list)
    spreads: list[float] = []
    tokens = 0
    with TypeSafeClient(model=MODEL) as client:
        for row in rows:
            state = json.loads(row[args.state_col]) if args.state_json else {"text": row[args.state_col]}
            label = row[args.label_col].strip()
            signals: list[float] = []
            correct = False
            band_value = 0.0
            for _ in range(args.repeat):
                r = client.system_one(state=state, questions=QUESTIONS)  # all questions, as in production
                tokens += r.usage.input_tokens or 0
                ans = r.answers[args.question]
                if qtype == "choice":
                    correct = ans.choice == label
                    band_value = ans.confidence
                    signals.append(ans.probabilities.get(ans.choice, 0.0))
                elif qtype == "score":
                    correct = round(ans.score) == int(label)
                    band_value = ans.confidence
                    signals.append(ans.score)
                else:
                    correct = (ans.noul > 0.5) == (label.lower() in TRUE_LABELS)
                    band_value = abs(ans.noul - 0.5) * 2
                    signals.append(ans.noul)
            if len(signals) > 1:
                spreads.append(statistics.pstdev(signals))
            per_band[band_of(band_value, edges)].append(correct)

    n = len(rows)
    print(f"question {args.question} ({qtype}), rows {n}, repeat {args.repeat}, input tokens {tokens}")
    print(f"{'band':>14} {'rows':>5} {'share':>6} {'accuracy':>9}")
    for band in sorted(per_band):
        hits = per_band[band]
        print(f"{band:>14} {len(hits):>5} {len(hits)/n:>6.0%} {sum(hits)/len(hits):>9.0%}" + ("   (few rows)" if len(hits) < 20 else ""))
    if spreads:
        print(f"repeat spread: mean std {statistics.mean(spreads):.3f}, max {max(spreads):.3f}")
    print("Pick the automatic band where accuracy meets the cost of a wrong action; report its share as the automation rate.")


if __name__ == "__main__":
    main()
