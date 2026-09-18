#!/usr/bin/env python3
"""Tests for evaluate.py. No network: urlopen is replaced by a fake API.

    python3 -m unittest discover -s skills/tenbin/scripts -p '*_test.py'
"""
from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
import urllib.error
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))
import evaluate  # noqa: E402

QUESTIONS = {
    "refund": {"type": "noul", "instructions": "Does `review.text` explicitly ask for a refund?"},
    "cause": {
        "type": "choice",
        "instructions": "According to `review.text`, what caused the problem?",
        "criteria": {"shipping": "Crushed box, broken on arrival.", "defect": "Failed without external damage.", "other": "None of the above."},
    },
    "tone": {
        "type": "score",
        "instructions": "How hostile is the tone of `review.text`?",
        "criteria": ["Neutral report.", "Mild disappointment.", "Assigns blame."],
    },
}


class Headers(dict):
    def get(self, k, d=None):  # urllib headers are case-insensitive
        return super().get(k.lower(), d)


class Resp(io.BytesIO):
    def __init__(self, body: bytes, headers: Headers):
        super().__init__(body)
        self.headers = headers

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def http_error(status: int, body: str = "{}", headers: dict | None = None) -> urllib.error.HTTPError:
    return urllib.error.HTTPError("https://api.test/v1/systemone", status, "err", Headers(headers or {}), io.BytesIO(body.encode()))


class FakeApi:
    """Answers are driven by `state.review.n`: refund yes when n is even, cause cycles, tone = n % 3."""

    def __init__(self, fail_first: list | None = None):
        self.requests: list[dict] = []
        self.auth: list[str | None] = []
        self.fail_first = list(fail_first or [])

    def __call__(self, req, timeout=0):
        self.auth.append(req.headers.get("Authorization"))
        body = json.loads(req.data)
        self.requests.append(body)
        if self.fail_first:
            raise self.fail_first.pop(0)
        n = body["state"]["review"].get("n", 0)
        causes = ["shipping", "defect", "other"]
        cause = causes[n % 3]
        answers = {}
        for qid, q in body["questions"].items():
            if q["type"] == "noul":
                answers[qid] = {"type": "noul", "noul": 0.9 if n % 2 == 0 else 0.1}
            elif q["type"] == "choice":
                probs = {k: (0.8 if k == cause else 0.1) for k in q["criteria"]}
                answers[qid] = {"type": "choice", "choice": cause, "probabilities": probs, "confidence": 0.8}
            else:
                answers[qid] = {"type": "score", "score": float(n % 3) + 0.1, "legend": {}, "probabilities": {}, "confidence": 0.55 + 0.1 * (n % 4)}
        out = {"model": "jev-1.13.0", "answers": answers, "usage": {"input_tokens": 100, "output_tokens": 10}}
        return Resp(json.dumps(out).encode(), Headers({"x-typesafe-request-id": f"req-{len(self.requests)}"}))


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)
        self.request = self.dir / "request.json"
        self.request.write_text(json.dumps({"state": {"review": {"text": "broken, refund please", "n": 0}}, "questions": QUESTIONS}))
        self.env_patch = mock.patch.dict(os.environ, {"TYPESAFE_API_KEY": "good"}, clear=False)
        self.env_patch.start()
        os.environ.pop("TYPESAFE_DEFAULT_MODEL", None)
        mock.patch("evaluate.time.sleep", lambda s: None).start()

    def tearDown(self):
        mock.patch.stopall()
        self.env_patch.stop()
        self.tmp.cleanup()

    def run_cli(self, *argv: str, api: FakeApi | None = None) -> tuple[int, str, str]:
        api = api or FakeApi()
        out, err = io.StringIO(), io.StringIO()
        code = 0
        with mock.patch("evaluate.urllib.request.urlopen", api), mock.patch.object(sys, "argv", ["evaluate.py", *argv]):
            with redirect_stdout(out), redirect_stderr(err):
                try:
                    evaluate.main()
                except SystemExit as e:
                    code = e.code if isinstance(e.code, int) else 1
                    if isinstance(e.code, str):
                        err.write(e.code)
        return code, out.getvalue(), err.getvalue()

    def write_rows(self, n: int, labels: bool = True) -> Path:
        p = self.dir / "rows.jsonl"
        lines = []
        for i in range(n):
            row = {"state": {"review": {"text": f"review {i}", "n": i}}}
            if labels:
                row["labels"] = {"refund": i % 2 == 0, "cause": ["shipping", "defect", "other"][i % 3], "tone": i % 3}
            lines.append(json.dumps(row))
        p.write_text("\n".join(lines) + "\n")
        return p


class EnvAndKey(Base):
    def test_env_file_parses_key_value_lines_and_ignores_comments(self):
        p = self.dir / "env"
        p.write_text("# comment\nTYPESAFE_API_KEY='k1'\nTYPESAFE_DEFAULT_MODEL=jev-1.13.0\nbroken line\n")
        self.assertEqual(evaluate.read_env_file(p), {"TYPESAFE_API_KEY": "k1", "TYPESAFE_DEFAULT_MODEL": "jev-1.13.0"})

    def test_missing_env_file_is_empty(self):
        self.assertEqual(evaluate.read_env_file(self.dir / "nope"), {})

    def test_missing_key_exits_without_calling_the_api(self):
        os.environ.pop("TYPESAFE_API_KEY")
        api = FakeApi()
        code, _, err = self.run_cli(str(self.request), "--env-file", str(self.dir / "nope"), api=api)
        self.assertEqual(code, 1)
        self.assertIn("TYPESAFE_API_KEY is not set", err)
        self.assertEqual(api.requests, [])

    def test_key_and_model_come_from_env_file_when_env_var_is_unset(self):
        os.environ.pop("TYPESAFE_API_KEY")
        (self.dir / "env").write_text("TYPESAFE_API_KEY=filekey\nTYPESAFE_DEFAULT_MODEL=jev-1.13.0\n")
        api = FakeApi()
        code, out, _ = self.run_cli(str(self.request), "--env-file", str(self.dir / "env"), api=api)
        self.assertEqual(code, 0, out)
        self.assertEqual(api.auth, ["Bearer filekey"])
        self.assertEqual(api.requests[0]["model"], "jev-1.13.0")

    def test_env_var_beats_env_file(self):
        (self.dir / "env").write_text("TYPESAFE_API_KEY=filekey\n")
        api = FakeApi()
        self.run_cli(str(self.request), "--env-file", str(self.dir / "env"), api=api)
        self.assertEqual(api.auth, ["Bearer good"])

    def test_key_never_appears_in_output(self):
        code, out, err = self.run_cli(str(self.request))
        self.assertEqual(code, 0)
        self.assertNotIn("good", out + err)


class SingleMode(Base):
    def test_sends_state_model_and_all_questions_in_one_call(self):
        api = FakeApi()
        code, out, _ = self.run_cli(str(self.request), api=api)
        self.assertEqual(code, 0)
        self.assertEqual(len(api.requests), 1)
        body = api.requests[0]
        self.assertEqual(body["model"], "jev-latest")
        self.assertEqual(set(body["questions"]), set(QUESTIONS))
        self.assertEqual(body["state"]["review"]["n"], 0)
        result = json.loads(out)
        self.assertEqual(result["model"], "jev-1.13.0")
        self.assertEqual(result["answers"]["cause"]["choice"], "shipping")
        self.assertEqual(result["request_id"], "req-1")
        self.assertAlmostEqual(result["cost_usd"], 100 * 0.042 / 1e6)
        self.assertEqual(result["session"]["calls"], 1)

    def test_model_in_request_file_wins_over_flag_and_env(self):
        doc = json.loads(self.request.read_text())
        doc["model"] = "jev-preview"
        self.request.write_text(json.dumps(doc))
        api = FakeApi()
        self.run_cli(str(self.request), "--model", "jev-1.13.0", api=api)
        self.assertEqual(api.requests[0]["model"], "jev-preview")

    def test_model_flag_beats_default(self):
        api = FakeApi()
        self.run_cli(str(self.request), "--model", "jev-1.13.0", api=api)
        self.assertEqual(api.requests[0]["model"], "jev-1.13.0")

    def test_repeat_reports_spread_and_choice_histogram(self):
        api = FakeApi()
        code, out, _ = self.run_cli(str(self.request), "--repeat", "3", api=api)
        self.assertEqual(code, 0)
        self.assertEqual(len(api.requests), 3)
        result = json.loads(out)
        self.assertEqual(len(result["runs"]), 3)
        self.assertEqual(result["repeat_spread"]["cause"]["choices"], {"shipping": 3})
        self.assertEqual(result["repeat_spread"]["refund"]["std"], 0.0)
        self.assertEqual(result["session"]["calls"], 3)

    def test_repeat_sends_a_distinct_sample_uid_per_call_and_single_run_sends_none(self):
        api = FakeApi()
        self.run_cli(str(self.request), "--repeat", "2", api=api)
        uids = [r["state"]["sample_uid"] for r in api.requests]
        self.assertEqual(len(set(uids)), 2)
        self.assertEqual(api.requests[0]["state"]["review"]["n"], 0, "the state's own fields are untouched")
        api = FakeApi()
        self.run_cli(str(self.request), api=api)
        self.assertNotIn("sample_uid", api.requests[0]["state"])
        self.assertEqual(evaluate.with_sample_uid("plain text", "s0"), {"content": "plain text", "sample_uid": "s0"})

    def test_lint_error_blocks_the_call(self):
        doc = json.loads(self.request.read_text())
        doc["questions"]["cause"]["criteria"] = None
        self.request.write_text(json.dumps(doc))
        api = FakeApi()
        code, _, err = self.run_cli(str(self.request), api=api)
        self.assertEqual(code, 2)
        self.assertIn("lint error", err)
        self.assertEqual(api.requests, [])

    def test_lint_warning_is_printed_but_does_not_block(self):
        doc = json.loads(self.request.read_text())
        doc["questions"]["tone"]["criteria"] = ["1", "2", "3"]  # numeric-only levels
        self.request.write_text(json.dumps(doc))
        api = FakeApi()
        code, _, err = self.run_cli(str(self.request), api=api)
        self.assertEqual(code, 0)
        self.assertIn("lint warning", err)
        self.assertEqual(len(api.requests), 1)


class Errors(Base):
    def test_401_is_described_with_request_id(self):
        api = FakeApi(fail_first=[http_error(401, '{"error":"bad"}', {"x-typesafe-request-id": "r401"})])
        code, _, err = self.run_cli(str(self.request), api=api)
        self.assertEqual(code, 1)
        self.assertIn("rejected the API key (401)", err)
        self.assertIn("r401", err)
        self.assertEqual(len(api.requests), 1)  # no retry on 401

    def test_422_points_to_lint(self):
        api = FakeApi(fail_first=[http_error(422, '{"detail":"criteria"}')])
        code, _, err = self.run_cli(str(self.request), api=api)
        self.assertEqual(code, 1)
        self.assertIn("(422)", err)
        self.assertIn("lint_questions.py", err)

    def test_429_then_success_is_retried(self):
        api = FakeApi(fail_first=[http_error(429, "", {"retry-after": "1"}), http_error(529)])
        code, out, _ = self.run_cli(str(self.request), api=api)
        self.assertEqual(code, 0)
        self.assertEqual(len(api.requests), 3)
        self.assertEqual(json.loads(out)["session"]["failures"], 0)

    def test_retry_after_ms_then_retry_after_seconds_are_honoured_and_capped(self):
        waits: list[float] = []
        mock.patch("evaluate.time.sleep", waits.append).start()
        api = FakeApi(fail_first=[
            http_error(429, "", {"retry-after-ms": "1500"}),
            http_error(429, "", {"retry-after": "2"}),
            http_error(429, "", {"retry-after": "600"}),
            http_error(408),
        ])
        code, _, _ = self.run_cli(str(self.request), api=api)
        self.assertEqual(code, 0)
        self.assertEqual(waits[:3], [1.5, 2.0, evaluate.MAX_RETRY_WAIT_S])
        self.assertEqual(len(api.requests), 5)

    def test_429_beyond_max_attempts_fails(self):
        api = FakeApi(fail_first=[http_error(429)] * evaluate.MAX_ATTEMPTS)
        code, _, err = self.run_cli(str(self.request), api=api)
        self.assertEqual(code, 1)
        self.assertIn("Rate limited (429)", err)
        self.assertEqual(len(api.requests), evaluate.MAX_ATTEMPTS)

    def test_connection_failure_is_reported(self):
        api = FakeApi(fail_first=[urllib.error.URLError("refused")] * evaluate.MAX_ATTEMPTS)
        code, _, err = self.run_cli(str(self.request), api=api)
        self.assertEqual(code, 1)
        self.assertIn("could not reach", err)

    def test_state_over_per_call_limit_is_caught_by_lint_before_sending(self):
        doc = json.loads(self.request.read_text())
        doc["state"]["review"]["text"] = "x" * (evaluate.TOTAL_TOKENS * 4 + 10)
        self.request.write_text(json.dumps(doc))
        api = FakeApi()
        code, _, err = self.run_cli(str(self.request), api=api)
        self.assertEqual(code, 2)
        self.assertIn("lint error", err)
        self.assertEqual(api.requests, [])

    def test_client_refuses_oversized_calls_itself(self):
        client = evaluate.Client("k", "jev-latest", "https://api.test", 10**9)
        big = "x" * (evaluate.TOTAL_TOKENS * 4)
        with self.assertRaisesRegex(ValueError, "per-call limit"):
            client.system_one(big, QUESTIONS)
        long_q = {"q": {"type": "noul", "instructions": "y" * (evaluate.STATE_AND_LONGEST * 4)}}
        with self.assertRaisesRegex(ValueError, "longest question"):
            client.system_one("s", long_q)

    def test_run_budget_stops_further_calls(self):
        api = FakeApi()
        code, _, err = self.run_cli(str(self.request), "--repeat", "3", "--budget-tokens", "250", api=api)
        self.assertEqual(code, 1)
        self.assertIn("run budget", err)
        self.assertEqual(len(api.requests), 2)  # 100 + 100 used, third estimate would exceed 250


class RowsMode(Base):
    def test_labelled_rows_give_per_band_accuracy_and_stats(self):
        rows = self.write_rows(24)
        api = FakeApi()
        out_file = self.dir / "res.jsonl"
        code, out, _ = self.run_cli(str(self.request), "--rows", str(rows), "--out", str(out_file), api=api)
        self.assertEqual(code, 0, out)
        self.assertEqual(len(api.requests), 24)
        self.assertIn("rows 24  ok 24  failed 0  skipped 0", out)
        # every fake answer matches its label, so every band reads 100%
        self.assertIn("refund (noul)", out)
        self.assertIn("cause (choice)", out)
        self.assertIn("shipping 8, defect 8, other 8", out)
        for line in out.splitlines():
            if line.strip().startswith("["):
                self.assertTrue(line.rstrip().endswith("100%") or line.rstrip().endswith("(few rows)"), line)
        self.assertNotIn("fewer than 20 labelled rows", out)
        self.assertEqual(len(out_file.read_text().splitlines()), 24)
        first = json.loads(out_file.read_text().splitlines()[0])
        self.assertEqual(first["status"], "ok")
        self.assertEqual(first["labels"]["cause"], "shipping")

    def test_wrong_labels_lower_accuracy(self):
        rows = self.dir / "rows.jsonl"
        rows.write_text("\n".join(json.dumps({"state": {"review": {"n": i}}, "labels": {"refund": True}}) for i in range(4)) + "\n")
        code, out, _ = self.run_cli(str(self.request), "--rows", str(rows))
        self.assertEqual(code, 0)
        band_lines = [l for l in out.splitlines() if l.strip().startswith("[")]
        self.assertEqual(len(band_lines), 1)
        self.assertIn("50%", band_lines[0])  # n even -> 0.9 (True), n odd -> 0.1 (False)

    def test_few_rows_are_flagged_provisional(self):
        rows = self.write_rows(5)
        code, out, _ = self.run_cli(str(self.request), "--rows", str(rows))
        self.assertEqual(code, 0)
        self.assertIn("fewer than 20 labelled rows", out)
        self.assertIn("(few rows)", out)

    def test_unlabelled_rows_give_stats_without_bands(self):
        rows = self.write_rows(6, labels=False)
        code, out, _ = self.run_cli(str(self.request), "--rows", str(rows))
        self.assertEqual(code, 0)
        self.assertIn("cause (choice)", out)
        self.assertNotIn("band", out)

    def test_repeat_runs_each_row_repeat_times(self):
        rows = self.write_rows(3)
        api = FakeApi()
        code, out, _ = self.run_cli(str(self.request), "--rows", str(rows), "--repeat", "2", api=api)
        self.assertEqual(code, 0)
        self.assertEqual(len(api.requests), 6)
        self.assertIn("repeat spread", out)

    def test_401_stops_scheduling_and_skips_the_rest(self):
        rows = self.write_rows(5)
        api = FakeApi(fail_first=[http_error(401)])
        code, out, _ = self.run_cli(str(self.request), "--rows", str(rows), "--concurrency", "1", api=api)
        self.assertEqual(code, 0)
        self.assertEqual(len(api.requests), 1)
        self.assertIn("ok 0  failed 1  skipped 4", out)
        self.assertIn("row 0: TypeSafe rejected the API key (401)", out)

    def test_422_on_one_row_keeps_the_others(self):
        rows = self.write_rows(3)
        api = FakeApi(fail_first=[http_error(422, '{"detail":"x"}')])
        code, out, _ = self.run_cli(str(self.request), "--rows", str(rows), "--concurrency", "1", api=api)
        self.assertEqual(code, 0)
        self.assertEqual(len(api.requests), 3)
        self.assertIn("ok 2  failed 1  skipped 0", out)

    def test_too_many_rows_is_refused(self):
        rows = self.write_rows(3)
        api = FakeApi()
        code, _, err = self.run_cli(str(self.request), "--rows", str(rows), "--max-rows", "2", api=api)
        self.assertEqual(code, 1)
        self.assertIn("exceeds --max-rows", err)
        self.assertEqual(api.requests, [])


class Helpers(unittest.TestCase):
    def test_band_of_uses_half_open_intervals(self):
        edges = [0.5, 0.8]
        self.assertEqual(evaluate.band_of(0.0, edges), "[0.00,0.50)")
        self.assertEqual(evaluate.band_of(0.5, edges), "[0.50,0.80)")
        self.assertEqual(evaluate.band_of(0.8, edges), "[0.80,1.00]")
        self.assertEqual(evaluate.band_of(1.0, edges), "[0.80,1.00]")

    def test_judge_choice_score_noul(self):
        self.assertEqual(evaluate.judge("choice", {"choice": "a", "confidence": 0.7, "probabilities": {"a": 0.7}}, "a")[:2], (True, 0.7))
        self.assertEqual(evaluate.judge("score", {"score": 1.4, "confidence": 0.6}, 1)[0], True)
        self.assertEqual(evaluate.judge("score", {"score": 1.6, "confidence": 0.6}, "1")[0], False)
        correct, band, _ = evaluate.judge("noul", {"noul": 0.9}, "yes")
        self.assertTrue(correct)
        self.assertAlmostEqual(band, 0.8)
        self.assertTrue(evaluate.judge("noul", {"noul": 0.2}, False)[0])
        self.assertFalse(evaluate.judge("noul", {"noul": 0.2}, 1)[0])

    def test_estimate_matches_four_chars_per_token(self):
        s, q, longest = evaluate.estimate("abcd" * 10, {"a": {"type": "noul", "instructions": "x" * 40}})
        self.assertEqual(s, 11)  # 42 chars with quotes -> ceil(42/4)
        self.assertEqual(q, longest)


if __name__ == "__main__":
    unittest.main()
