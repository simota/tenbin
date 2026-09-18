"""All TypeSafe questions, weights and thresholds for <feature> in one file.

Edit here only. Thresholds carry the evidence they were set from; a threshold without
a dataset line is provisional and must be re-measured before the band is widened.
"""
from typesafe_sdk import Choice, Noul, Score

MODEL = "jev-latest"

# --- questions: every question the workflow may need, evaluated in one call ---------------
QUESTIONS = {
    "category": Choice(
        instructions="What is this support message about?",
        criteria={
            "bug_report": "Something in the product behaves wrongly",
            "billing": "Charges, invoices, refunds, payment methods",
            "feature_request": "Asks for something the product does not do",
            "other": "None of the above",
        },
    ),
    "bug_severity": Score(  # only read when category == bug_report
        instructions="If the message reports a bug, how severe is it?",
        criteria=[
            "Cosmetic or wording issue",
            "Broken feature, but a workaround exists",
            "Broken feature with no workaround",
            "Data loss, security exposure or the product is unusable",
        ],
    ),
    "has_repro_steps": Noul(
        instructions="The message contains steps that would let an engineer reproduce the problem",
    ),
    "refund_requested": Noul(
        instructions="The customer asks for money back",
    ),
    "frustration": Score(
        instructions="How frustrated is the customer?",
        criteria=[
            "Calm, states facts",
            "Frustrated but civil",
            "Very angry, strong language or threatens to leave",
            "Abusive or threatening",
        ],
    ),
}

# --- thresholds: per action, scaled by the cost of a wrong action --------------------------
# measured: <dataset>, <n rows>, <date>; band accuracy from templates/eval_thresholds.py
THRESHOLDS = {
    "category_auto": 0.75,      # provisional — measure before raising automation
    "category_confirm": 0.50,   # provisional
    "severity_escalate": 1.5,   # score position; level 2 = no workaround
    "repro_present": 0.60,      # provisional
    "refund_likely": 0.70,      # provisional
    "frustration_flag": 1.5,    # provisional
}

# --- composite weights (each Score normalised by len(criteria) - 1) -----------------------
PRIORITY_WEIGHTS = {"bug_severity": 0.6, "frustration": 0.4}


def norm(answers, qid: str) -> float:
    return answers[qid].score / (len(QUESTIONS[qid].criteria) - 1)


def priority(answers) -> float:
    return sum(w * norm(answers, qid) for qid, w in PRIORITY_WEIGHTS.items())
