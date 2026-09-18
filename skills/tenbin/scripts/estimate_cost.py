#!/usr/bin/env python3
"""Estimate tokens and cost for a TypeSafe request before sending it.

    python estimate_cost.py request.json [--calls N]

request.json is {"state": ..., "questions": {...}}. Estimate: JSON length / 4 chars per token
(the same rule tenbin uses). Price: $0.042 per million input tokens, output free.
"""
from __future__ import annotations

import argparse
import json
import math

PRICE_PER_MTOK_USD = 0.042
TOTAL_TOKENS = 64_000
STATE_AND_LONGEST = 32_000


def tokens(v) -> int:
    return math.ceil(len(json.dumps(v, ensure_ascii=False, separators=(",", ":"))) / 4)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("request")
    ap.add_argument("--calls", type=int, default=1, help="how many states will be sent with these questions")
    args = ap.parse_args()
    with open(args.request, encoding="utf-8") as fh:
        doc = json.load(fh)
    state, questions = doc.get("state", ""), doc["questions"]
    s = tokens(state)
    per_q = {qid: tokens(q) for qid, q in questions.items()}
    total = s + sum(per_q.values())
    longest = max(per_q.values(), default=0)
    print(f"state tokens            {s}")
    print(f"questions tokens        {sum(per_q.values())}  (longest {longest})")
    print(f"total per call          {total}  (limit {TOTAL_TOKENS}; state+longest limit {STATE_AND_LONGEST})")
    if total > TOTAL_TOKENS or s + longest > STATE_AND_LONGEST:
        print("OVER LIMIT: trim the state or split the questions")
    print(f"cost per call           ${total * PRICE_PER_MTOK_USD / 1e6:.6f}")
    print(f"cost for {args.calls} calls  ${args.calls * total * PRICE_PER_MTOK_USD / 1e6:.4f}")


if __name__ == "__main__":
    main()
