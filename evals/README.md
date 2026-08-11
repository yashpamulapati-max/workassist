# Work Assist — Eval Automation

Public share package for **quality evaluation** of **Work Assist** — the Trimble Agentic AI assistant embedded in AgileAssets (stage: `ams-ok-yp2`) — using **Trimble Agent Studio** and the **Evals API**.

**Repo:** [yashpamulapati-max/work-assist-evals](https://github.com/yashpamulapati-max/work-assist-evals)  
**Audience:** reviewers / interviewers who need to understand *what these evals are for* and *what we are trying to achieve* (not just how to run scripts).

---

## What are these evals for?

**Work Assist** answers product/how-to questions and uses tools (FAQ/KB, Web Search, Confluence, Jira). In Agent Studio we can only select **one test set + one metric set** per evaluation, so we built focused suites that each check a distinct risk.

| Suite | What it proves | Primary metric |
|-------|----------------|----------------|
| **WA-01** FAQ Exact Answers | Mandatory FAQ answers stay exact / on-policy | Output Quality |
| **WA-02** Public Documentation | Grounding in public / Learning Center docs *(skipped in v1 unique-metrics track)* | Output Quality |
| **WA-03** Internal Confluence | Faithful use of internal Confluence via E-Tools | Faithfulness |
| **WA-04** Jira Tools (archive) | Generic Jira tool use — **do not re-run**; replaced by WA-08 | Agent Evaluation |
| **WA-08** Jira AMS_OK / OKCRM | Fleet, Roadway/MMS, AMS_OK (+ write confirm) on real project shapes | Agent Evaluation |
| **WA-05** Source Priority | Public vs internal routing + FAQ exactness | Prompt Alignment |
| **WA-06** No Live Data Safety | No invented live DB / WO counts when Oracle/REST MCP is unavailable | Hallucination |
| **WA-07** Terminology Workflow | Correct AgileAssets wording *(skipped in v1 unique-metrics track)* | Output Quality |

**v1 scope:** KB/FAQ, Web Search, E-Tools Confluence/Jira — **no Oracle/REST MCP** in Studio. Safety suite (WA-06) explicitly checks that the agent does not hallucinate live operational data under that constraint.

Run log, scores, fail patterns (A–K), and remediation notes live in [`EVAL-SUMMARY.md`](EVAL-SUMMARY.md).

---

## What we are trying to achieve

This work is not “dump JSON into Studio once.” The target end-state is a **repeatable quality loop** around Work Assist:

```text
Work Assist (system under test)
        │
        ▼
 Test sets (WA-01…WA-08)  ──►  Agent Studio evals (baseline, SME-visible)
        │
        ▼
 Evals API automation (OpenAPI → discovery → smoke → suite runner)
        │
        ▼
 Ideal: Evals API as MCP tool on an orchestrator agent
        │
        ▼
 Gates + remediation rules (re-run, patch instructions, fix expectedTools,
 metric mismatch vs real agent failure) → CI / regression on change
```

### Goals (in order)

1. **Baseline quality in Studio** — Importable test sets + a metric playbook so failures are interpretable (case fail vs metric mismatch vs harness/platform).
2. **Automate the same jobs via API** — Create datasets, run `EVALUATE_AGENT`, poll results without clicking Studio each time (proven with a 1-case smoke: Prompt Alignment **1.0 PASSED**).
3. **Scale without a human SME on every case** — Use LLM-as-judge metrics already in Studio/Evals, but treat “prove the judge” as part of the system (thresholds, expected tools/output, fail-pattern rules).
4. **Close the platform gap** — Ideal missing piece: **agent edit/publish → auto-run matching test sets**. Until that exists, automation + MCP is the practical path.
5. **Encode remediations for an auto-eval agent** — When a metric fails, apply documented rules (e.g. WA-01 Summarization vs verbatim FAQ; WA-08 confirm-before-write; WA-05 `expectedTools`), not blind re-runs.

**Work Assist** remains the **agent under test** (`agentId`). An optional “WA Eval Analyst” would only analyze results — it is **not** a Work Assist sub-agent, and localization JSON is irrelevant to this path.

---

## What this repo contains

| Path | Purpose |
|------|---------|
| `WA-*.json` | Test sets in Agent Studio import format |
| `EVAL-SUMMARY.md` | Run log, metric playbook, fail patterns, remediations |
| `README-import.md` | How to create / import test sets in Studio |
| `evaluation-results-WA-*-summary.json` | Compact exported result summaries |
| `api/openapi.yaml` | Confirmed Evals API schema snapshot |
| `api/discover_evals_api.py` | OpenAPI discovery + optional smoke evaluate |
| `api/run_smoke_one_case.py` | Minimal 1-case `EVALUATE_AGENT` job |
| `api/STEP-BY-STEP.md` | Token/env + discovery + smoke guide |
| `api/.env.example` | Env template (**no secrets**) |

---

## Security

**Do not commit tokens.** Copy `.env.example` → `api/.env.local` and paste a short-lived bearer there only (editor paste, not chat).

```bash
cd api
cp .env.example .env.local
# edit .env.local: set EVALS_BEARER_TOKEN
```

Ignored by design: `.env*`, `api/discovery-out/`, OpenAPI downloads that are not the checked-in `openapi.yaml`.

Stage Evals host for TID stage tokens: `https://evals.stage.trimble-ai.com` (prod host rejects wrong audience).

---

## Quick start (API)

1. Read [`api/STEP-BY-STEP.md`](api/STEP-BY-STEP.md)
2. Get a short-lived bearer (developer portal / Studio)
3. Then:

```bash
cd api
python3 discover_evals_api.py --openapi-file ./openapi.yaml
python3 run_smoke_one_case.py
```

---

## Current status (unique-metrics track)

| Suite | Outcome | Notes |
|-------|---------|--------|
| WA-01 | Failed overall | Cases 100% pass; Summarization gate mismatch on verbatim FAQ |
| WA-03 | Failed | Faithfulness avg below threshold |
| WA-04 | Failed (archive) | Replaced by WA-08 |
| WA-08 | Failed 2/7 | Instruction / confirm-before-write / policy patterns A–E |
| WA-05 | Failed 1/3 | Dataset `expectedTools` issues; patterns F–I |
| WA-06 | **Passed** 3/3 | Hallucination avg 0.00 |
| WA-02 / WA-07 | Skipped | Deferred |

**API:** OpenAPI reviewed; authenticated discovery + 1-case smoke succeeded. Next engineering steps: suite runner over WA JSON, then Evals API MCP on an orchestrator.

---

## Owner

Personal review/share repo (`yashpamulapati-max`). Not part of Trimble-Agentic org infrastructure.
