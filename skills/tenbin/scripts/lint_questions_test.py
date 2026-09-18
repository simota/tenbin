#!/usr/bin/env python3
"""Tests for lint_questions.py; the rules must match tenbin/src/lint.ts (see lint.test.ts)."""
from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lint_questions import lint  # noqa: E402

REPO = Path(__file__).resolve().parents[3]


def rules(r: dict) -> list[tuple[str, str, str]]:
    return [(f["severity"], f["question_id"], f["rule"]) for f in r["errors"] + r["warnings"] + r["infos"]]


class CleanQuestions(unittest.TestCase):
    def test_clean_questions_produce_no_errors_or_warnings(self):
        r = lint({
            "department": {"type": "choice", "instructions": "Which team should handle this ticket?", "criteria": {"billing": "Charges", "technical": "Bugs", "other": None}},
            "frustration": {"type": "score", "instructions": "How frustrated is the customer?", "criteria": ["Calm, just stating facts", "Frustrated but civil", "Very angry, strong language"]},
            "is_urgent": {"type": "noul", "instructions": "Does the message convey urgency or time-sensitivity?"},
        }, "My card was charged twice.")
        self.assertEqual(r["errors"], [])
        self.assertEqual(r["warnings"], [])

    def test_repo_examples_lint_clean(self):
        for name in ("triage", "guardrail", "extraction"):
            doc = json.loads((REPO / "tenbin" / "resources" / "examples" / f"{name}.json").read_text())
            r = lint(doc["questions"], doc.get("state"))
            self.assertEqual(r["errors"], [], name)
        # extraction.json is the official "Advanced: structure" example and must be warning-free
        doc = json.loads((REPO / "tenbin" / "resources" / "examples" / "extraction.json").read_text())
        self.assertEqual(lint(doc["questions"], doc["state"])["warnings"], [])


class StructuredShapes(unittest.TestCase):
    """Official 'Advanced: structure' shapes must not be flagged."""

    state = {"source_text": "Invoice #4471 issued March 3, 2026 to Beaver Dam Logistics, net 30."}

    def test_instruction_object_keys_resolve_against_the_instructions(self):
        r = lint({"q": {"type": "noul", "instructions": {"field": {"name": "invoice_number"}, "extracted_value": "4471",
                                                          "question": "Does `extracted_value` match the `field` as it appears in `source_text`?"}}}, self.state)
        self.assertEqual(r["warnings"], [])

    def test_key_in_neither_state_nor_instructions_still_warns(self):
        r = lint({"q": {"type": "noul", "instructions": {"question": "Does `extracted_value` match `source_text`?"}}}, self.state)
        self.assertIn(("warning", "q", "state_path_missing"), rules(r))

    def test_bucketed_how_many_score_is_info_but_noul_is_warning(self):
        r = lint({
            "payment_terms": {"type": "score", "instructions": {"field": {"name": "payment_terms", "unit": "days"}, "question": "How many days does the `field` in `source_text` allow for payment?"},
                              "criteria": ["Due on receipt", "Net 10", "Net 30", "Net 60", "Net 90"]},
            "n_items": {"type": "noul", "instructions": "How many items are listed in `source_text`?"},
        }, self.state)
        self.assertIn(("info", "payment_terms", "counting_or_math"), rules(r))
        self.assertIn(("warning", "n_items", "counting_or_math"), rules(r))

    def test_structured_noul_criteria_are_inspected_on_what(self):
        ok = lint({"q": {"type": "noul", "instructions": "Is the customer asking for a refund?",
                         "criteria": {"true": {"what": "Asks for money back", "examples": ["refund me"]}, "false": {"what": "No refund mentioned"}}}})
        self.assertEqual(ok["warnings"], [])
        inverted = lint({"q": {"type": "noul", "instructions": "Is the record free of PII?",
                               "criteria": {"true": {"what": "No personal data present"}, "false": {"what": "Personal data present"}}}})
        self.assertIn(("warning", "q", "noul_criteria_inverted"), rules(inverted))


class ClassicRules(unittest.TestCase):
    def test_counting_date_compound_and_id_only_warn(self):
        r = lint({
            "n_items": {"type": "noul", "instructions": "How many items are listed in the order?"},
            "overdue": {"type": "noul", "instructions": "Is the invoice due date before today?"},
            "both": {"type": "noul", "instructions": "Is the customer angry and asking for a refund or a replacement?"},
            "refund_requested": {"type": "noul", "instructions": "Refund?"},
        })
        got = {rule for _, _, rule in rules(r)}
        for rule in ("counting_or_math", "date_comparison", "compound_instruction", "id_only_semantics"):
            self.assertIn(rule, got)

    def test_choice_and_score_ranges_are_errors(self):
        r = lint({
            "c": {"type": "choice", "instructions": "Which one?", "criteria": None},
            "s": {"type": "score", "instructions": "How bad?", "criteria": ["only one"]},
        })
        self.assertIn(("error", "c", "choice_options_range"), rules(r))
        self.assertTrue(any(qid == "s" and sev == "error" for sev, qid, _ in rules(r)))

    def test_state_paths_resolve_through_arrays(self):
        state = {"ticket": {"messages": [{"text": "hi"}]}, "order": {"id": "A-1"}}
        r = lint({"q": {"type": "noul", "instructions": "Does `ticket.messages[0].text` mention `order.total`?"}}, state)
        self.assertEqual([x for x in rules(r) if x[2] == "state_path_missing"], [("warning", "q", "state_path_missing")])


if __name__ == "__main__":
    unittest.main()
