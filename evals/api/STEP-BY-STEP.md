# Work Assist — Evals API step-by-step

**Security:** Never commit `.env.local` or paste bearer tokens into git/PRs.

This guide is for **automating Agent Studio evaluations** via Trimble’s Evals API (`https://evals.ai.trimble.com`), not for logging into Okta inside Cursor.

---

## 0. Big picture (read this first)

Today you run evals like this in the **browser**:

1. Pick agent **Work Assist**
2. Pick a **test set** (e.g. WA-05)
3. Pick a **metric set** (e.g. Prompt Alignment ≥ 90%)
4. Click **Create evaluation job**
5. Download `evaluation-results-*.json`

The **API does the same four things**, with different names:

| Studio UI | API |
|-----------|-----|
| Test set | **Dataset** + **records** |
| Metric set | **Evaluator** (+ optional **successCriteria**) |
| Create evaluation job | `POST /v1/jobs` with `type: EVALUATE_AGENT` |
| Download results | `GET /v1/results?jobId=...` |

We are **not** guessing request fields. First we **discover** the official OpenAPI schema, then we run one tiny smoke job, then we build a reusable runner.

```text
YOU  →  get token + OpenAPI
     →  run discover_evals_api.py   (read / inspect only)
     →  review schema-analysis.json
     →  (later) --smoke-evaluate    (1 case, non-prod)
     →  (later) regression runner for WA-01…WA-08
```

---

## 1. What you need before any script

- Access to [Trimble Agentic AI developer docs](https://developer.ai.trimble.com) (same Okta you use for Agent Studio)
- Work Assist agent id (stage): `37242c15-9716-4b91-9032-e8f7390d1d80`
- This folder on disk: `api/`

You do **not** need to give Cursor your Okta password.

---

## 2. Get a bearer token (safe way)

The API wants:

```http
Authorization: Bearer <token>
```

### Option A — From the API docs “Test Request” (easiest)

1. Open the Evals API docs (Datasets / Evaluation Jobs pages you already found).
2. Sign in with Okta in the **browser**.
3. On any endpoint (e.g. List evaluators), open **Test Request** / auth panel.
4. Complete OAuth if prompted (client id/secret from Trimble’s docs, or “login with TID”).
5. After a successful test call, copy the **access token** (Bearer value only).
6. Token is short-lived — if discovery fails with 401 later, get a fresh one.

### Option B — From browser DevTools (if Test Request is awkward)

1. Log into Agent Studio or the developer portal.
2. Open DevTools → **Network**.
3. Trigger any API call to `evals.ai.trimble.com`.
4. Open the request → Headers → `Authorization: Bearer …`
5. Copy that token into `.env.local` (below).

**Never** paste the token into Slack/chat/git. Only into a local `.env.local` file.

**Important:** Pasting a JWT into chat can corrupt it (we saw `Invalid token signature` when the token was relayed through chat). Prefer: copy token → open `api/.env.local` in the editor → paste once → save. Then tell the agent “token refreshed” without pasting the value again.

---

## 3. Save credentials locally

In a terminal:

```bash
cd api (this folder)
cp .env.example .env.local
```

Edit `.env.local`:

```bash
EVALS_BEARER_TOKEN=paste_token_here_no_quotes_needed
EVALS_BASE_URL=https://evals.ai.trimble.com
WORK_ASSIST_AGENT_ID=37242c15-9716-4b91-9032-e8f7390d1d80
```

Leave `EVALS_SUCCESS_CRITERIA_*` and `EVALS_KB_LIBRARY_LINKS` empty for now.

`.env.local` is gitignored — do not commit it.

---

## 4. Get the OpenAPI spec (required for “don’t assume”)

Unauthenticated download of `https://evals.ai.trimble.com/openapi.json` often returns **403**. So:

### Preferred

1. On the developer portal API page for Evals, look for **Download OpenAPI** / **Export** / raw `openapi.json`.
2. Save the file as:

```text
api/openapi.json
```

### Alternate

If the portal shows the full schema in the browser, use **Save As** on the openapi URL after you are logged in (copy URL from Network tab if needed).

We need this file so the script only uses **paths and field names that Trimble documented**.

---

## 5. Run discovery (inspect only — no evaluation job yet)

```bash
cd api (this folder)
python3 discover_evals_api.py --openapi-file ./openapi.json
```

If OpenAPI fetch works with your token alone, you can omit `--openapi-file`:

```bash
python3 discover_evals_api.py
```

### What “success” looks like

A new folder appears:

```text
discovery-out/YYYYMMDDTHHMMSSZ/
  openapi.raw.json
  paths-summary.json          ← every GET/POST the API exposes
  schema-analysis.json        ← answers our schema questions
  live-datasets.json          ← your existing Studio datasets (if any)
  live-evaluators.json        ← metric templates (faithfulness, etc.)
  live-jobs.json
  live-results.json
  evaluators-metrics-excerpt.json
  discovery-summary.json
```

Terminal will print things like:

- `datasetType enum: [...]`
- whether records support `expectedOutput`, `expectedTools`, `metadata`, `messages`
- whether jobs have `successCriteria`
- HTTP status of list GETs (200 = good)

---

## 6. How to read the results (what we are trying to learn)

Open `schema-analysis.json` and check these questions:

### A. Dataset type for WA cases

Our WA JSON files are almost always **one user message** per case (not a long multi-turn chat).

| If OpenAPI enum includes… | Use for WA single-prompt cases |
|---------------------------|--------------------------------|
| `QUERY` (or similar single-prompt name) | Prefer that |
| only `CONVERSATION` | Use `CONVERSATION` with a one-message `messages` array (same as Studio import) |

Do **not** invent a type name that is not in the enum.

### B. Record fields

| Question | Look for property names like… |
|----------|-------------------------------|
| Expected answer text? | `expectedOutput`, `expectedResponse`, … |
| Expected tools? | `expectedTools`, `expectedToolCalls`, … |
| Extra tags (SRC-01, etc.)? | `metadata` |
| Multi-turn chat? | `messages` array of `{role, content}` |

If a field is **missing** from the schema, Studio UI may still show it — but the API runner must not send it until the spec supports it.

### C. Score scale (hallucination 0.05 vs 5%)

In Studio you set “Hallucination ≤ 5%”. Internally scores might be `0–1` or `0–100`.

Check `evaluators-metrics-excerpt.json` → each evaluator’s `outputMetrics`.  
Also check `successCriteria` schema under `job_create` in `schema-analysis.json`.

**Only then** decide whether a criterion is `0.05` or `5` (or whatever the schema says).

### D. Which evaluator to use for a smoke run

From `live-evaluators.json` / excerpt, pick an id whose name matches what you used in Studio, e.g.:

- Prompt Alignment (for WA-05)
- Hallucination (for WA-06)

Copy the evaluator `id` (UUID). You may need it as `evaluator:<uuid>` in the job `assignee`.

---

## 7. (Later) One minimal smoke evaluation

Only after step 6 looks clear:

```bash
python3 discover_evals_api.py --openapi-file ./openapi.json --smoke-evaluate \
  --suite-name 'WA-05 Source Priority Regression' \
  --cases-file ../WA-05-Source-Priority.json \
  --evaluator-id 'PASTE_EVALUATOR_UUID'
```

What this does (on purpose, small):

1. Creates a **new** dataset named like `WA-05 Source Priority Regression`
2. Uploads **only the first** test case from WA-05
3. Starts **one** `EVALUATE_AGENT` job against Work Assist
4. Polls job status and pulls results
5. Saves request/response JSON under the same `discovery-out/...` folder

If create-dataset fails because `kbLibraryLinks` is required, set in `.env.local`:

```bash
EVALS_KB_LIBRARY_LINKS=your-kb-library-uuid
```

(Get that UUID from Agent Studio Knowledge / KB libraries, or from docs.)

If the job fails because `successCriteria` is required, export the exact JSON shape from OpenAPI examples into:

```bash
EVALS_SUCCESS_CRITERIA_FILE=./success-criteria.smoke.json
```

— still **no guessing** thresholds.

---

## 8. (Later) Reusable regression runner

After smoke payloads look like Studio’s downloaded results:

- Script/wrapper that loops WA-01…WA-08 JSON → dataset → job → results
- Apply remediation rules from `EVAL-SUMMARY.md` (patterns A–K)

We build that **after** smoke validation, not before.

---

## 9. Common problems

| Symptom | Likely fix |
|---------|------------|
| `Missing auth` | Set `EVALS_BEARER_TOKEN` in `.env.local` |
| `401` on live GETs | Token expired — get a new one |
| `Could not fetch OpenAPI` | Use `--openapi-file ./openapi.json` |
| Create dataset 400 on `kbLibraryLinks` | Set `EVALS_KB_LIBRARY_LINKS` |
| Create job 400 on `successCriteria` | Supply criteria file from OpenAPI schema |
| Job runs but metrics “wrong scale” | Re-read evaluator `outputMetrics`; fix criteria |

---

## 10. Checklist (print and tick)

- [ ] Logged into developer portal / Agent Studio in browser  
- [ ] Copied bearer token into `api/.env.local` (not into chat)  
- [ ] Saved `api/openapi.json`  
- [ ] Ran `python3 discover_evals_api.py --openapi-file ./openapi.json`  
- [ ] Opened `discovery-out/.../schema-analysis.json`  
- [ ] Noted `datasetType` enum and record field support  
- [ ] Noted evaluator ids + score scale from metrics excerpt  
- [ ] (Only then) ran `--smoke-evaluate` with one WA-05 case  
- [ ] Compared smoke result JSON to a Studio download  
- [ ] Asked to build the full regression runner  

---

## What to send back when stuck

Without secrets, paste or attach:

- `discovery-summary.json`
- the `dataset_create` / `records_add` / `job_create` sections of `schema-analysis.json`
- `evaluators-metrics-excerpt.json` (ids + outputMetrics only)

Then we can interpret schemas and decide the exact smoke payload together.
