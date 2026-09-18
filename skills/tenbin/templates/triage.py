"""Speculative fan-out + confidence-gated routing.

One request carries every question; code decides which answers matter. Thresholds come
from questions.py so this file holds only the routing.
"""
from typesafe_sdk import TypeSafeClient

from questions import MODEL, QUESTIONS, THRESHOLDS, priority


def triage(ticket: dict, client: TypeSafeClient) -> dict:
    """Returns the action to take and the raw answers, so the decision stays auditable."""
    r = client.system_one(state={"ticket": ticket}, questions=QUESTIONS)
    a = r.answers
    category = a["category"]

    if category.confidence < THRESHOLDS["category_confirm"]:
        action = {"route": "human", "reason": "category unclear"}
    elif category.confidence < THRESHOLDS["category_auto"]:
        action = {"route": "confirm", "suggested": category.choice}
    elif category.choice == "bug_report":
        severe = a["bug_severity"].score > THRESHOLDS["severity_escalate"]
        repro = a["has_repro_steps"].noul > THRESHOLDS["repro_present"]
        action = {"route": "engineering" if severe and repro else "bug_backlog"}
    elif category.choice == "billing":
        action = {"route": "billing", "refund_likely": a["refund_requested"].noul > THRESHOLDS["refund_likely"]}
    elif category.choice == "feature_request":
        action = {"route": "product"}
    else:
        action = {"route": "human", "reason": "other"}

    # independent of category
    action["priority"] = priority(a)
    action["flag_frustration"] = a["frustration"].score > THRESHOLDS["frustration_flag"]

    return {
        "action": action,
        "answers": r.raw_http_response.json()["answers"],
        "request_id": r.request_id,
        "input_tokens": r.usage.input_tokens,
    }


if __name__ == "__main__":
    import json
    import sys

    with TypeSafeClient(model=MODEL) as client:  # key from TYPESAFE_API_KEY
        print(json.dumps(triage(json.load(sys.stdin), client), indent=2, default=str))
