#!/usr/bin/env python3
"""Lint a TypeSafe questions map without calling the API.

Mirrors the rules of tenbin (src/lint.ts). Usage:

    python lint_questions.py questions.json [--state state.json] [--max-tokens 64000] [--forbidden cardNumber,customer.ssn]

questions.json is either {"<id>": {...}} or {"state": ..., "questions": {...}}.
Exit code 1 when any error is found.
"""
from __future__ import annotations

import argparse
import json
import math
import re
import sys
from typing import Any

TOTAL_TOKENS = 64_000
STATE_AND_LONGEST = 32_000
MAX_CHOICE_OPTIONS = 255
MIN_SCORE_LEVELS, MAX_SCORE_LEVELS = 2, 10

DEGREE_ONLY = re.compile(
    r"^(very|somewhat|moderately|slightly|extremely|quite|fairly|highly|mildly|a bit|a little)?\s*"
    r"(low|medium|high|severe|mild|good|bad|strong|weak|poor|great|positive|negative|neutral|urgent|"
    r"important|relevant|frustrated|angry|calm|likely|unlikely|small|large|big)\s*$", re.I)
COUNTING = re.compile(
    r"\b(how many|count|number of|total of|sum of|difference between|average of|percentage of|"
    r"days between|hours between|older than \d|larger than \d|greater than \d|less than \d|more than \d)\b", re.I)
DATE_COMPARE = re.compile(
    r"\b(before|after) (the )?(\d+|today|yesterday|tomorrow|date|deadline|due date|"
    r"(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*)\b"
    r"|\b(earlier than|later than|within \d+ (days?|weeks?|months?|years?)|expired|overdue|due date)\b"
    r"|\bbetween .* and .*(19|20)\d\d\b", re.I)
DOUBLE_NEG = re.compile(r"\b(not un\w+|doesn't fail to|does not fail to|isn't not|never fails to|not impossible|not without)\b", re.I)
NEGATION_START = re.compile(r"^\s*(no|not|never|none|doesn't|does not|isn't|is not|lacks|without)\b", re.I)
OTHER_OPTION = re.compile(r"^(other|none|none_of_the_above|none of the above|unknown|not_stated|not stated|n/a|unclear)$", re.I)
PATH = re.compile(r"`([A-Za-z_][\w.\[\]-]*)`")


def criterion_text(v: Any) -> str:
    """A Noul criterion is a string or an object such as {what, examples}; compare on its wording."""
    if isinstance(v, str):
        return v
    if isinstance(v, dict) and isinstance(v.get("what"), str):
        return v["what"]
    return ""


def text(v: Any) -> str:
    return v if isinstance(v, str) else json.dumps(v if v is not None else "", ensure_ascii=False)


def tokens(v: Any) -> int:
    return math.ceil(len(json.dumps(v if v is not None else None, ensure_ascii=False, separators=(",", ":"))) / 4)


def joins(s: str) -> int:
    return len(re.findall(r"\b(and|or)\b", s, re.I))


def resolve(state: Any, path: str) -> bool:
    parts = [p for p in re.sub(r"\[(\d+)\]", r".\1", path).split(".") if p]
    cur = state
    for p in parts:
        if isinstance(cur, list):
            if not p.isdigit() or int(p) >= len(cur):
                return False
            cur = cur[int(p)]
        elif isinstance(cur, dict):
            if p not in cur:
                return False
            cur = cur[p]
        else:
            return False
    return True


# Set by evaluate.py --repeat / evaluate_many; never referenced by a question.
IMPLICIT_STATE_FIELDS = {"sample_uid"}


def covers(a: str, b: str) -> bool:
    return a == b or b.startswith(a + ".") or b.startswith(a + "[")


def unused_state_fields(state: Any, used: list[str]) -> list[str]:
    """Object-key paths of state that no question path touches (names it, an ancestor or a descendant).

    Arrays count as one field; only the highest unused ancestor is returned."""
    out: list[str] = []

    def walk(obj: dict[str, Any], prefix: str) -> None:
        for key, value in obj.items():
            if not prefix and key in IMPLICIT_STATE_FIELDS:
                continue
            path = f"{prefix}.{key}" if prefix else key
            if any(covers(u, path) for u in used):
                continue
            if any(covers(path, u) for u in used):
                if isinstance(value, dict):
                    walk(value, path)
                continue
            out.append(path)

    if isinstance(state, dict):
        walk(state, "")
    return out


def forbidden_state_paths(state: Any, forbidden: list[str]) -> list[str]:
    """Every path in state (indices normalised to []) equal to a forbidden entry or ending with .<entry>."""
    hits: dict[str, None] = {}

    def walk(value: Any, path: str) -> None:
        if path and any(path == f or path.endswith("." + f) for f in forbidden):
            hits[path] = None
        if isinstance(value, list):
            for item in value:
                walk(item, f"{path}[]")
        elif isinstance(value, dict):
            for key, child in value.items():
                walk(child, f"{path}.{key}" if path else key)

    walk(state, "")
    return list(hits)


def lint(questions: dict[str, Any], state: Any = None, max_tokens: int = TOTAL_TOKENS, forbidden: list[str] | None = None) -> dict[str, Any]:
    findings: list[dict[str, str]] = []

    def push(qid: str, rule: str, sev: str, msg: str, fix: str) -> None:
        findings.append({"question_id": qid, "rule": rule, "severity": sev, "message": msg, "fix": fix})

    if not questions:
        push("", "no_questions", "error", "questions is empty", "Add at least one question.")

    for qid, q in questions.items():
        qtype = q.get("type") if isinstance(q, dict) else None
        if qtype not in ("noul", "choice", "score"):
            push(qid, "unknown_type", "error", f"type must be noul, choice or score (got {qtype!r})", "Set type to one of the three primitives.")
            continue
        instr = text(q.get("instructions"))
        crit = q.get("criteria")

        if qtype == "score":
            levels = crit if isinstance(crit, list) else None
            if levels is None or not (MIN_SCORE_LEVELS <= len(levels) <= MAX_SCORE_LEVELS):
                push(qid, "score_levels_range", "error",
                     f"Score criteria must be an ordered array of {MIN_SCORE_LEVELS}–{MAX_SCORE_LEVELS} levels (got {len(levels) if levels is not None else type(crit).__name__})",
                     "Describe 2–10 distinct situations, low to high.")
            else:
                if all(isinstance(l, str) and re.fullmatch(r"\s*[\d.]+\s*", l) for l in levels):
                    push(qid, "numeric_only_levels", "warning", "Score levels are numbers only; the model never sees level numbers, only descriptions",
                         "Describe the situation at each level, e.g. 'Broken feature, but a workaround exists'.")
                for i, l in enumerate(levels):
                    s = text(l)
                    if isinstance(l, str) and DEGREE_ONLY.match(s):
                        push(qid, "degree_words_in_levels", "warning", f'Level {i} ("{s}") is a degree word, not a situation',
                             "Describe what the state looks like at this level, with examples if needed.")
                    if isinstance(l, str) and joins(s) >= 2:
                        push(qid, "multi_dimension_level", "warning", f'Level {i} joins several properties ("{s[:60]}")',
                             "One Score measures one dimension. Split into separate Score questions and combine in code.")

        if qtype == "choice":
            opts = list(crit.keys()) if isinstance(crit, dict) else None
            if opts is None or not (1 <= len(opts) <= MAX_CHOICE_OPTIONS):
                push(qid, "choice_options_range", "error",
                     f"Choice criteria must be a map of 1–{MAX_CHOICE_OPTIONS} options (got {len(opts) if opts is not None else type(crit).__name__})",
                     "Provide a map of option name to description (or null). Split >255 options into two stages.")
            elif not any(OTHER_OPTION.match(o) for o in opts):
                push(qid, "no_other_option", "info", "No 'other' / 'none of the above' option",
                     "Add one if the list might not cover every input, so the model can say nothing fits.")

        if qtype == "noul" and isinstance(crit, dict):
            t, f = criterion_text(crit.get("true")), criterion_text(crit.get("false"))
            if t and f and NEGATION_START.match(t) and not NEGATION_START.match(f):
                push(qid, "noul_criteria_inverted", "warning",
                     "criteria.true starts with a negation while criteria.false is affirmative; check that a high noul really means 'yes' to the instructions",
                     "Prefer phrasing instructions so that the affirmative case is criteria.true.")

        words = len(instr.split())
        if isinstance(q.get("instructions"), str) and words < 3 and re.search(r"[_-]", qid):
            push(qid, "id_only_semantics", "warning", f'instructions is only {words} word(s); the question id "{qid}" is NOT sent to the model',
                 "Write the complete question in instructions.")
        if isinstance(q.get("instructions"), str) and joins(instr) >= 2:
            push(qid, "compound_instruction", "warning", "instructions joins several judgments with and/or",
                 "Ask one atomic question per judgment and combine the answers in code.")
        if COUNTING.search(instr):
            if qtype == "score" and isinstance(crit, list):
                push(qid, "counting_or_math", "info",
                     "instructions asks 'how many' or similar; fine when the Score levels are named buckets (e.g. 'Net 30'), not when the model must compute the number",
                     "Keep it if each level names a situation or range the model can read off the text; otherwise compute in code.")
            else:
                push(qid, "counting_or_math", "warning", "instructions asks for counting or arithmetic; Jev is not a calculator",
                     "Enumerate candidates in code and ask one Noul per item, compute the number in code, or bucket it into Score levels.")
        if DATE_COMPARE.search(instr):
            push(qid, "date_comparison", "warning", "instructions compares dates or times; Jev reads dates as text",
                 "Extract date parts with Choice questions (with a 'not stated' option) and compare in code.")
        if DOUBLE_NEG.search(instr):
            push(qid, "double_negative", "warning", "instructions contains a double negative",
                 "Rephrase directly; split into two literal questions if needed.")
        if state is not None:
            instr_obj = q.get("instructions") if isinstance(q.get("instructions"), dict) else None
            for path in PATH.findall(text(q.get("instructions"))):
                # Structured instructions (official "Advanced: structure") refer to their own keys, e.g. `field`.
                if not resolve(state, path) and not (instr_obj is not None and resolve(instr_obj, path)):
                    push(qid, "state_path_missing", "warning", f"path `{path}` referenced in instructions does not exist in state or in the instructions object",
                         "Fix the path or add the field to state.")

    if state is not None:
        for path in forbidden_state_paths(state, forbidden or []):
            push("", "state_path_forbidden", "error", f"state contains forbidden path `{path}`",
                 "Remove the field in code before building the state; the model must never see it.")
        # Only when the questions use the path convention at all; otherwise every field would be "unused".
        used = [p for q in questions.values() if isinstance(q, dict)
                for p in PATH.findall(text(q.get("instructions"))) if resolve(state, p)]
        if used:
            for path in unused_state_fields(state, used):
                push("", "state_field_unused", "warning", f"state field `{path}` is not referenced by any question",
                     "Remove it from the state (irrelevant content lowers accuracy) or reference it from a question.")

    est_state = tokens(state if state is not None else "")
    per_q = [tokens(q) for q in questions.values()]
    est_questions = sum(per_q)
    longest = max(per_q, default=0)
    total = est_state + est_questions
    limit = min(max_tokens, TOTAL_TOKENS)
    if total > limit:
        push("", "token_budget", "error", f"estimated {total} tokens for state + questions exceeds the {limit} token limit",
             "Send only the state fields the questions need, or split states across calls.")
    elif est_state + longest > STATE_AND_LONGEST:
        push("", "token_budget", "error", f"estimated state + longest question = {est_state + longest} tokens exceeds the {STATE_AND_LONGEST} token limit",
             "Trim the state or the longest question.")
    elif total > 0.8 * limit:
        push("", "token_budget", "warning", f"estimated {total} tokens is within 20% of the limit", "Consider trimming state.")

    return {
        "errors": [f for f in findings if f["severity"] == "error"],
        "warnings": [f for f in findings if f["severity"] == "warning"],
        "infos": [f for f in findings if f["severity"] == "info"],
        "estimated_tokens": {"state": est_state, "questions": est_questions, "longest_question": longest, "total": total},
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("questions", help="JSON file: questions map, or {state, questions}")
    ap.add_argument("--state", help="JSON file with the state (overrides an embedded one)")
    ap.add_argument("--max-tokens", type=int, default=TOTAL_TOKENS)
    ap.add_argument("--forbidden", default="", help="comma-separated field names or dot-paths the state must not contain")
    args = ap.parse_args()

    with open(args.questions, encoding="utf-8") as fh:
        doc = json.load(fh)
    state = None
    questions = doc
    if isinstance(doc, dict) and "questions" in doc and isinstance(doc["questions"], dict) and "type" not in doc:
        questions, state = doc["questions"], doc.get("state")
    if args.state:
        with open(args.state, encoding="utf-8") as fh:
            state = json.load(fh)

    result = lint(questions, state, args.max_tokens, [f for f in args.forbidden.split(",") if f])
    json.dump(result, sys.stdout, indent=2, ensure_ascii=False)
    print()
    return 1 if result["errors"] else 0


if __name__ == "__main__":
    sys.exit(main())
