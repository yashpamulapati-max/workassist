# Work Assist

Umbrella project for **Work Assist** — the Trimble Agentic AI assistant embedded in AgileAssets
(stage environment: `ams-ok-yp2`). This repo collects the artifacts around building, embedding, and
evaluating the assistant.

> Owner: personal review/share repo (`yashpamulapati-max`). Not part of Trimble-Agentic org
> infrastructure. Do not commit tokens or secrets.

## Contents

| Path | Purpose |
| ---- | ------- |
| [`evals/`](./evals) | Work Assist quality-evaluation package: Agent Studio test sets (WA-01…WA-08), Evals API discovery/smoke runner, run log, and remediation notes. Mirrored from [work-assist-evals](https://github.com/yashpamulapati-max/work-assist-evals). |

## What is Work Assist?

Work Assist answers product/how-to questions and uses tools (FAQ/KB, Web Search, Confluence, Jira)
inside AgileAssets. It is embedded as a floating chat panel via the Trimble Agentic iframe SDK.

## Evaluation (see `evals/`)

The `evals/` folder is the quality loop around Work Assist:

```
Work Assist (system under test)
      │
      ▼
Test sets (WA-01…WA-08) ──► Agent Studio evals (baseline, SME-visible)
      │
      ▼
Evals API automation (OpenAPI → discovery → smoke → suite runner)
      │
      ▼
Gates + remediation rules → CI / regression on change
```

See [`evals/README.md`](./evals/README.md) for the full breakdown of suites, goals, and current status.

## Branches

- `main` — stable.
- `develop` — active work.

## Security

- **Never commit tokens.** For the evals API, copy `evals/api/.env.example` → `evals/api/.env.local`
  and paste a short-lived bearer there only.
- Ignored by design: `.env*`, `evals/api/discovery-out/`, and downloaded OpenAPI files that are not
  the checked-in `evals/api/openapi.yaml`.
