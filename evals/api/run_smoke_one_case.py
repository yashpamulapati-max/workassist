#!/usr/bin/env python3
"""
One-case smoke evaluation for Work Assist — uses only fields confirmed in openapi.yaml.

Creates:
  - 1 CONVERSATION dataset
  - 1 record (FAQ: How do I create a work order?)
  - 1 EVALUATE_AGENT job (Prompt Alignment if found, else first evaluator)
  - polls job + fetches results

Usage:
  cd media/work-assist-evals/api
  # Put token in .env.local (do NOT paste token into chat — chat can corrupt JWTs)
  python3 run_smoke_one_case.py
"""

from __future__ import annotations

import json
import os
import ssl
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
AGENT_ID = "37242c15-9716-4b91-9032-e8f7390d1d80"
SUITE_NAME = "WA-SMOKE FAQ Create WO (1 case)"

# OpenAPI SuccessCriterion.threshold is min 0 max 1 → use 0–1 scale (e.g. 0.90 not 90).
SUCCESS_CRITERIA_PROMPT_ALIGNMENT = [
    {
        "metricName": "prompt_alignment",
        "function": "avg",
        "operator": "gte",
        "threshold": 0.9,
    }
]


def load_env() -> None:
    """Load .env.local / .env. File values win over empty shell exports for EVALS_* keys."""
    for name in (".env.local", ".env"):
        path = SCRIPT_DIR / name
        if not path.is_file():
            continue
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip("'").strip('"')
            if k.startswith("EVALS_") or k.startswith("WORK_ASSIST_") or k.startswith("TID_"):
                os.environ[k] = v
            else:
                os.environ.setdefault(k, v)


def ssl_context() -> ssl.SSLContext | None:
    verify = os.environ.get("EVALS_SSL_VERIFY", "true").lower() not in ("0", "false", "no")
    if verify:
        return None
    return ssl._create_unverified_context()


def http(method: str, url: str, token: str, body: dict | None = None) -> tuple[int, dict | list | str]:
    data = None
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json",
        "User-Agent": "wa-evals-smoke/0.1",
    }
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    ctx = ssl_context()
    try:
        with urllib.request.urlopen(req, timeout=120, context=ctx) as resp:
            raw = resp.read().decode()
            return resp.status, json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode(errors="replace")
        try:
            parsed: dict | list | str = json.loads(raw)
        except Exception:
            parsed = raw
        return e.code, parsed


def pick_evaluator(items: list[dict]) -> dict:
    prefer = ("prompt alignment", "prompt_alignment", "hallucination")
    for needle in prefer:
        for it in items:
            name = (it.get("name") or "").lower()
            if needle.replace("_", " ") in name or needle in name:
                return it
    if not items:
        raise SystemExit("No evaluators returned — cannot create job.")
    return items[0]


def metric_names(ev: dict) -> list[str]:
    out = []
    for m in ev.get("outputMetrics") or []:
        if isinstance(m, dict):
            n = m.get("metricName") or m.get("name")
            if n:
                out.append(n)
        elif isinstance(m, str):
            out.append(m)
    return out


def build_success_criteria(ev: dict) -> list[dict]:
    names = {n.lower(): n for n in metric_names(ev)}
    # Prefer prompt_alignment on 0–1 scale per OpenAPI SuccessCriterion.threshold
    for key in ("prompt_alignment", "answer_relevancy", "faithfulness"):
        if key in names:
            return [{"metricName": names[key], "function": "avg", "operator": "gte", "threshold": 0.9}]
    if "hallucination" in names:
        return [{"metricName": names["hallucination"], "function": "avg", "operator": "lte", "threshold": 0.05}]
    first = metric_names(ev)[0]
    return [{"metricName": first, "function": "avg", "operator": "gte", "threshold": 0.9}]


def main() -> None:
    load_env()
    token = os.environ.get("EVALS_BEARER_TOKEN")
    if not token:
        raise SystemExit("Set EVALS_BEARER_TOKEN in .env.local (paste in editor, not chat).")
    base = os.environ.get("EVALS_BASE_URL", "https://evals.ai.trimble.com").rstrip("/")
    agent_id = os.environ.get("WORK_ASSIST_AGENT_ID", AGENT_ID)
    out = SCRIPT_DIR / "discovery-out" / f"smoke-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    out.mkdir(parents=True, exist_ok=True)
    print(f"Output: {out}")
    print(f"Base URL: {base}")
    print(f"Agent: {agent_id}")

    # 1) Auth check + list evaluators
    status, body = http("GET", f"{base}/v1/evaluators?pageSize=50", token)
    (out / "01-evaluators.json").write_text(json.dumps({"status": status, "body": body}, indent=2, default=str))
    if status != 200:
        raise SystemExit(
            f"GET /v1/evaluators failed HTTP {status}.\n"
            f"Body: {body}\n"
            "If signature invalid: re-copy token into .env.local via editor (chat may corrupt JWTs).\n"
            "Also set EVALS_SSL_VERIFY=false if you hit SSL errors behind corp proxy."
        )
    items = body.get("items") if isinstance(body, dict) else []
    ev = pick_evaluator(items or [])
    print(f"Evaluator: {ev.get('name')} ({ev.get('id')})")
    print(f"Metrics: {metric_names(ev)}")
    criteria = build_success_criteria(ev)
    print(f"successCriteria (0–1 scale per OpenAPI): {criteria}")

    # 2) Need kbLibraryLinks — reuse from an existing dataset if present, else env
    status, dbody = http("GET", f"{base}/v1/datasets?pageSize=50", token)
    (out / "02-datasets.json").write_text(json.dumps({"status": status, "body": dbody}, indent=2, default=str))
    kb_links = []
    if os.environ.get("EVALS_KB_LIBRARY_LINKS"):
        kb_links = [x.strip() for x in os.environ["EVALS_KB_LIBRARY_LINKS"].split(",") if x.strip()]
    elif status == 200 and isinstance(dbody, dict):
        for ds in dbody.get("items") or []:
            links = ds.get("kbLibraryLinks") or []
            if links:
                kb_links = list(links)
                print(f"Reusing kbLibraryLinks from dataset: {ds.get('name')}")
                break
    if not kb_links:
        # OpenAPI requires the field; try empty list — may 400
        print("WARN: no kbLibraryLinks found; trying empty list (may fail create).")
        kb_links = []

    # 3) Create dataset (CONVERSATION — agent chat records; QUERY is retrieval-only)
    create_ds = {
        "name": SUITE_NAME,
        "datasetType": "CONVERSATION",
        "description": "Non-prod smoke: single FAQ case for Work Assist. Safe to delete.",
        "kbLibraryLinks": kb_links,
    }
    status, body = http("POST", f"{base}/v1/datasets", token, create_ds)
    (out / "03-create-dataset.json").write_text(
        json.dumps({"status": status, "request": create_ds, "body": body}, indent=2, default=str)
    )
    if status not in (200, 201):
        raise SystemExit(f"Create dataset failed {status}: {body}")
    dataset_id = body["id"]
    print(f"Dataset: {dataset_id}")

    # 4) Add ONE conversation record (FAQ — simplest)
    record = {
        "recordType": "CONVERSATION",
        "messages": [{"role": "user", "content": "How do I create a work order?"}],
        "expectedOutput": (
            "Navigate to **Roadway > Progress > Day Cards**. Click **Insert** in the Work Orders grid. "
            "A dialog will appear — select your Project Type, Asset Type, Activity, and Inventory Element, "
            "clicking Next between each. Once the new row appears, fill in **Plan Quantity** and **PS Comments** "
            "(both required), then click **Save**. Your work order is now created and ready for resource assignment."
        ),
        "metadata": {"id": "SMOKE-FAQ-01", "source": "WA-05 SRC-01"},
        # expectedTools omitted — FAQ should use no tools; OpenAPI expects objects not bare strings
    }
    add_body = {"records": [record]}
    status, body = http("POST", f"{base}/v1/datasets/{dataset_id}/records", token, add_body)
    (out / "04-add-record.json").write_text(
        json.dumps({"status": status, "request": add_body, "body": body}, indent=2, default=str)
    )
    if status not in (200, 201):
        raise SystemExit(f"Add record failed {status}: {body}")
    print("Record: added 1 conversation case")

    # 5) Create job
    job = {
        "type": "EVALUATE_AGENT",
        "name": "SMOKE Work Assist FAQ 1-case",
        "description": "Minimal API smoke — one FAQ case. Review then delete.",
        "datasetId": dataset_id,
        "agentId": agent_id,
        "assignee": {"actors": [f"evaluator:{ev['id']}"]},
        "successCriteria": criteria,
    }
    status, body = http("POST", f"{base}/v1/jobs", token, job)
    (out / "05-create-job.json").write_text(
        json.dumps({"status": status, "request": job, "body": body}, indent=2, default=str)
    )
    if status not in (200, 201, 202):
        raise SystemExit(f"Create job failed {status}: {body}")
    job_id = body.get("id")
    print(f"Job: {job_id} status={body.get('status')}")

    # 6) Poll
    final = None
    for i in range(90):
        status, body = http("GET", f"{base}/v1/jobs/{job_id}", token)
        (out / "06-job-status.json").write_text(json.dumps({"poll": i, "status": status, "body": body}, indent=2, default=str))
        jstatus = (body or {}).get("status") if isinstance(body, dict) else None
        print(f"  poll {i}: {jstatus}")
        if str(jstatus).upper() in ("COMPLETED", "SUCCEEDED", "FAILED", "CANCELLED", "COMPLETE", "DONE"):
            final = body
            break
        time.sleep(10)
    if final is None:
        print("Timed out waiting for job; check 06-job-status.json and Studio Evaluations UI.")

    # 7) Results
    status, body = http("GET", f"{base}/v1/results?jobId={job_id}&pageSize=50", token)
    (out / "07-results.json").write_text(json.dumps({"status": status, "body": body}, indent=2, default=str))
    print(f"Results HTTP {status}")
    if isinstance(body, dict):
        items = body.get("items") or []
        print(f"Result count: {len(items)}")
        for it in items:
            print(
                " - outcome=",
                it.get("outcome"),
                "scores=",
                it.get("scores"),
                "actual=",
                (it.get("actualOutput") or "")[:180].replace("\n", " "),
            )

    summary = {
        "datasetId": dataset_id,
        "jobId": job_id,
        "evaluatorId": ev.get("id"),
        "evaluatorName": ev.get("name"),
        "successCriteria": criteria,
        "agentId": agent_id,
        "outDir": str(out),
        "note": "OpenAPI confirms threshold is 0–1. CONVERSATION used for agent FAQ case. Review 07-results.json.",
    }
    (out / "00-summary.json").write_text(json.dumps(summary, indent=2))
    print("\nDone. Review:", out / "07-results.json")
    print("Summary:", out / "00-summary.json")


if __name__ == "__main__":
    main()
