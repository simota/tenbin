#!/usr/bin/env python3
"""Tests for lint_questions.py; the rules must match tenbin/src/lint.ts (see lint.test.ts)."""
from __future__ import annotations

import json
import re
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lint_questions import IMAGE_TOKENS_PER_USE, lint, lint_assets  # noqa: E402

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


class StateFields(unittest.TestCase):
    def test_unused_fields_warn_with_arrays_and_sample_uid_handled(self):
        state = {"ticket": {"text": "refund please", "sender": "a@b.com"}, "customer": {"plan": "pro", "orders": [{"id": "A-1"}]},
                 "marketing": {"segment": "x"}, "sample_uid": "s0"}
        r = lint({"q": {"type": "noul", "instructions": "Does `ticket.text` ask for a refund on one of `customer.orders`?"}}, state)
        unused = sorted(re.search(r"`([^`]+)`", f["message"]).group(1) for f in r["warnings"] if f["rule"] == "state_field_unused")
        self.assertEqual(unused, ["customer.plan", "marketing", "ticket.sender"])
        self.assertEqual(r["errors"], [])
        covered = lint({"q": {"type": "noul", "instructions": "Does `ticket` ask for a refund?"}}, {"ticket": {"text": "x", "sender": "y"}})
        self.assertEqual(covered["warnings"], [])

    def test_unused_check_skipped_when_no_question_uses_paths(self):
        r = lint({"q": {"type": "noul", "instructions": "Is the customer asking for a refund?"}}, {"ticket": "refund please", "customer": {"plan": "pro"}})
        self.assertNotIn("state_field_unused", {rule for _, _, rule in rules(r)})

    def test_forbidden_names_and_paths_are_errors(self):
        state = {"customer": {"email": "a@b.com", "payment": {"cardNumber": "4111"}}, "orders": [{"id": "A-1", "card": {"cardNumber": "4222"}}], "ssn": "1"}
        q = {"q": {"type": "noul", "instructions": "Does `customer.email` look like a company address?"}}
        r = lint(q, state, forbidden=["cardNumber", "ssn"])
        self.assertEqual(sorted(re.search(r"`([^`]+)`", f["message"]).group(1) for f in r["errors"]),
                         ["customer.payment.cardNumber", "orders[].card.cardNumber", "ssn"])
        self.assertEqual(len(lint(q, state, forbidden=["customer.payment"])["errors"]), 1)
        self.assertEqual(lint(q, state)["errors"], [])


class BoxQuestions(unittest.TestCase):
    BOX = {"type": "box", "instructions": "the coffee mug in `photo`"}

    def box_model_severities(self, model):
        r = lint({"mug": self.BOX}, {"photo": "x"}, model=model)
        return [f["severity"] for f in r["errors"] + r["warnings"] if f["rule"] == "box_model"]

    def test_criteria_is_an_error(self):
        r = lint({"mug": {**self.BOX, "criteria": {"a": "b"}}}, {"photo": "x"})
        self.assertIn(("error", "mug", "box_criteria"), rules(r))

    def test_model_is_checked_only_when_given(self):
        self.assertEqual(self.box_model_severities("jev-1.13.0"), ["error"])
        self.assertEqual(self.box_model_severities("jev-latest"), ["warning"])
        self.assertEqual(self.box_model_severities("jev-preview"), [])
        self.assertEqual(self.box_model_severities(None), [])

    def test_presence_noul_is_suggested(self):
        self.assertIn(("info", "", "box_without_presence_check"), rules(lint({"mug": self.BOX}, {"photo": "x"})))
        paired = lint({"mug": self.BOX, "mug_visible": {"type": "noul", "instructions": "Is there a coffee mug in `photo`?"}}, {"photo": "x"})
        self.assertNotIn("box_without_presence_check", {rule for _, _, rule in rules(paired)})

    def test_box_needs_an_image_when_assets_are_known(self):
        self.assertIn(("error", "mug", "box_without_image"), rules(lint({"mug": self.BOX}, {"photo": "a kitchen"}, assets=[])))
        self.assertNotIn("box_without_image", {rule for _, _, rule in rules(lint({"mug": self.BOX}, {"photo": "a kitchen"}))})


class AssetReferences(unittest.TestCase):
    NOUL = {"type": "noul", "instructions": "Is there a person in `door`?"}

    def asset_rules(self, questions, state, assets):
        return [f"{f['severity']}:{f['rule']}" for f in lint_assets(questions, state, assets)]

    def test_same_findings_as_the_mcp(self):
        q = {"q": self.NOUL}
        self.assertEqual(self.asset_rules(q, {"door": "<door>"}, ["<door>"]), [])
        self.assertEqual(self.asset_rules(q, {"door": "<door>"}, ["<door>", "<extra>"]), ["error:asset_unreferenced"])
        self.assertEqual(self.asset_rules(q, {"<door>": "a photo"}, ["<door>"]), ["error:asset_unreferenced"], "object keys are not replaced")
        self.assertEqual(self.asset_rules(q, {"door": "cat"}, ["cat"]), ["warning:asset_reference_ambiguous"])
        long = "<" + "x" * 1_100 + ">"
        self.assertEqual(self.asset_rules(q, {"door": long}, [long]), ["error:asset_reference_size"])
        twice = {"a": {"type": "noul", "instructions": "Is `door` the person in <badge>?"},
                 "b": {"type": "noul", "instructions": "Does `door` show the uniform in <badge>?"}}
        self.assertEqual(self.asset_rules(twice, {"door": "<door>"}, ["<door>", "<badge>"]), ["warning:asset_in_many_instructions"])
        criteria = {"g": {"type": "choice", "instructions": "Which gesture is in `camera`?", "criteria": {"thumbs_up": {"examples": ["<thumb>"]}, "none": None}}}
        self.assertEqual(self.asset_rules(criteria, {"camera": "<cam>"}, ["<cam>", "<thumb>"]), [])

    def test_each_use_reserves_image_tokens(self):
        q = {"q": {"type": "noul", "instructions": "Is `door` the person in <badge>?"}}
        plain = lint(q, {"door": "<door>"})["estimated_tokens"]
        images = lint(q, {"door": "<door>"}, assets=["<door>", "<badge>"])["estimated_tokens"]
        self.assertEqual(images["state"] - plain["state"], IMAGE_TOKENS_PER_USE)
        self.assertEqual(images["questions"] - plain["questions"], IMAGE_TOKENS_PER_USE)


if __name__ == "__main__":
    unittest.main()
