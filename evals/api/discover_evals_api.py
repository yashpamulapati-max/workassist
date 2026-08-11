#!/usr/bin/env python3
"""
Trimble Evals API — authenticated discovery (read-mostly).

Does NOT invent endpoint paths or successCriteria. Discovers from OpenAPI first,
then optionally calls only paths confirmed in the spec.

Auth (pick one):
  export EVALS_BEARER_TOKEN='...'   # paste from docs "Test Request" / Studio session
  # OR client-credentials:
  export TID_CLIENT_ID=...
  export TID_CLIENT_SECRET=...
  export TID_TOKEN_URL='https://id.trimble.com/oauth/token'   # override if docs differ
  export TID_SCOPE='openid agents'                           # extend if evals needs more

Optional:
  export EVALS_BASE_URL='https://evals.ai.trimble.com'
  export EVALS_OPENAPI_URL='...'   # if auto-discovery fails, set exact OpenAPI URL
  export EVALS_OUT_DIR='...'       # default: ./discovery-out next to this script

Usage:
  python3 discover_evals_api.py                  # OpenAPI + read-only list calls
  python3 discover_evals_api.py --no-live        # OpenAPI / local file only
  python3 discover_evals_api.py --openapi-file /path/to/openapi.json

Smoke evaluate (disabled until you pass the flag AND schemas are present):
  python3 discover_evals_api.py --smoke-evaluate \\
    --agent-id 37242c15-9716-4b91-9032-e8f7390d1d80 \\
    --suite-name 'WA-05 Source Priority Regression' \\
    --cases-file ../WA-05-Source-Priority.json

Never commit tokens. Prefer .env.local (gitignored).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
DEFAULT_BASE = os.environ.get("EVALS_BASE_URL", "https://evals.ai.trimble.com").rstrip("/")
DEFAULT_TOKEN_URL = os.environ.get("TID_TOKEN_URL", "https://id.trimble.com/oauth/token")
DEFAULT_SCOPE = os.environ.get("TID_SCOPE", "openid agents")

# Candidate OpenAPI locations — tried in order; first 200 + JSON/YAML wins.
OPENAPI_CANDIDATES = [
    "/openapi.json",
    "/v1/openapi.json",
    "/openapi.yaml",
    "/openapi.yml",
    "/swagger/v1/swagger.json",
    "/swagger.json",
    "/v1/swagger.json",
    "/api/openapi.json",
    "/.well-known/openapi.json",
]


def _utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def _load_dotenv(path: Path) -> None:
    if not path.is_file():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        k, v = k.strip(), v.strip().strip("'").strip('"')
        os.environ.setdefault(k, v)


def get_token() -> str:
    tok = os.environ.get("EVALS_BEARER_TOKEN") or os.environ.get("TRIMBLE_EVALS_TOKEN")
    if tok:
        return tok.strip()

    cid = os.environ.get("TID_CLIENT_ID")
    secret = os.environ.get("TID_CLIENT_SECRET")
    if not cid or not secret:
        raise SystemExit(
            "Missing auth. Set EVALS_BEARER_TOKEN, or TID_CLIENT_ID + TID_CLIENT_SECRET.\n"
            "See .env.example in this folder."
        )

    body = urllib.parse.urlencode(
        {
            "grant_type": "client_credentials",
            "client_id": cid,
            "client_secret": secret,
            "scope": DEFAULT_SCOPE,
        }
    ).encode()
    req = urllib.request.Request(
        DEFAULT_TOKEN_URL,
        data=body,
        headers={"Content-Type": "application/x-www-form-urlencoded"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode())
    access = data.get("access_token")
    if not access:
        raise SystemExit(f"Token response missing access_token: {list(data.keys())}")
    return access


def http(
    method: str,
    url: str,
    token: str | None,
    body: dict | list | None = None,
    accept: str = "application/json",
) -> tuple[int, dict[str, str], Any]:
    data = None
    headers = {"Accept": accept, "User-Agent": "wa-evals-discover/0.1"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read()
            hdrs = {k.lower(): v for k, v in resp.headers.items()}
            ctype = hdrs.get("content-type", "")
            if "json" in ctype or (raw[:1] in (b"{", b"[")):
                try:
                    parsed: Any = json.loads(raw.decode() or "null")
                except json.JSONDecodeError:
                    parsed = raw.decode(errors="replace")
            else:
                parsed = raw.decode(errors="replace")
            return resp.status, hdrs, parsed
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            parsed = json.loads(raw.decode() or "null")
        except Exception:
            parsed = raw.decode(errors="replace")
        hdrs = {k.lower(): v for k, v in e.headers.items()} if e.headers else {}
        return e.code, hdrs, parsed


def save_json(path: Path, obj: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=2, default=str) + "\n")
    print(f"  wrote {path}")


def resolve_ref(spec: dict, ref: str) -> Any:
    if not ref.startswith("#/"):
        return {"$ref": ref, "_unresolved": True}
    node: Any = spec
    for part in ref[2:].split("/"):
        part = part.replace("~1", "/").replace("~0", "~")
        if not isinstance(node, dict) or part not in node:
            return {"$ref": ref, "_unresolved": True}
        node = node[part]
    return node


def expand_schema(spec: dict, schema: Any, depth: int = 0) -> Any:
    if schema is None or depth > 12:
        return schema
    if not isinstance(schema, dict):
        return schema
    if "$ref" in schema:
        resolved = resolve_ref(spec, schema["$ref"])
        if isinstance(resolved, dict) and not resolved.get("_unresolved"):
            merged = {**resolved, **{k: v for k, v in schema.items() if k != "$ref"}}
            return expand_schema(spec, merged, depth + 1)
        return schema
    out: dict[str, Any] = {}
    for k, v in schema.items():
        if k == "properties" and isinstance(v, dict):
            out[k] = {pk: expand_schema(spec, pv, depth + 1) for pk, pv in v.items()}
        elif k == "items":
            out[k] = expand_schema(spec, v, depth + 1)
        elif k in ("allOf", "oneOf", "anyOf") and isinstance(v, list):
            out[k] = [expand_schema(spec, x, depth + 1) for x in v]
        else:
            out[k] = v
    return out


def schema_prop_names(schema: Any) -> set[str]:
    names: set[str] = set()
    if not isinstance(schema, dict):
        return names
    props = schema.get("properties") or {}
    if isinstance(props, dict):
        names.update(props.keys())
    for key in ("allOf", "oneOf", "anyOf"):
        for part in schema.get(key) or []:
            names |= schema_prop_names(part)
    return names


def find_enum(schema: Any, prop: str) -> list[Any] | None:
    if not isinstance(schema, dict):
        return None
    props = schema.get("properties") or {}
    if prop in props and isinstance(props[prop], dict) and "enum" in props[prop]:
        return list(props[prop]["enum"])
    for key in ("allOf", "oneOf", "anyOf"):
        for part in schema.get(key) or []:
            found = find_enum(part, prop)
            if found is not None:
                return found
    return None


def load_openapi(token: str | None, out_dir: Path, openapi_file: str | None, openapi_url: str | None) -> dict:
    if openapi_file:
        path = Path(openapi_file)
        text = path.read_text()
        if path.suffix.lower() in (".yaml", ".yml"):
            try:
                import yaml  # type: ignore
            except ImportError as e:
                raise SystemExit("PyYAML required for YAML OpenAPI files: pip install pyyaml") from e
            spec = yaml.safe_load(text)
        else:
            spec = json.loads(text)
        save_json(out_dir / "openapi.raw.json", spec)
        return spec

    urls: list[str] = []
    if openapi_url:
        urls.append(openapi_url)
    elif os.environ.get("EVALS_OPENAPI_URL"):
        urls.append(os.environ["EVALS_OPENAPI_URL"])
    urls.extend(DEFAULT_BASE + p for p in OPENAPI_CANDIDATES)

    attempts = []
    for url in urls:
        # Try with and without bearer (some gateways serve OpenAPI publicly).
        for use_tok in (True, False):
            t = token if use_tok else None
            status, hdrs, body = http("GET", url, t, accept="application/json, application/yaml, text/yaml, */*")
            attempts.append({"url": url, "auth": use_tok, "status": status, "content_type": hdrs.get("content-type")})
            if status != 200:
                continue
            if isinstance(body, dict) and ("openapi" in body or "swagger" in body or "paths" in body):
                save_json(out_dir / "openapi.raw.json", body)
                save_json(out_dir / "openapi.fetch-attempts.json", attempts)
                print(f"OpenAPI loaded from {url} (auth={use_tok})")
                return body
            if isinstance(body, str) and ("openapi:" in body[:200] or "swagger:" in body[:200]):
                try:
                    import yaml  # type: ignore
                except ImportError as e:
                    raise SystemExit("OpenAPI is YAML; pip install pyyaml") from e
                spec = yaml.safe_load(body)
                save_json(out_dir / "openapi.raw.json", spec)
                (out_dir / "openapi.raw.yaml").write_text(body)
                save_json(out_dir / "openapi.fetch-attempts.json", attempts)
                print(f"OpenAPI YAML loaded from {url} (auth={use_tok})")
                return spec

    save_json(out_dir / "openapi.fetch-attempts.json", attempts)
    raise SystemExit(
        "Could not fetch OpenAPI from known candidates.\n"
        "Download the spec from the developer portal (Export / openapi.json) and re-run:\n"
        "  python3 discover_evals_api.py --openapi-file /path/to/openapi.json\n"
        f"Attempts logged in {out_dir / 'openapi.fetch-attempts.json'}"
    )


def summarize_paths(spec: dict) -> dict[str, Any]:
    paths = spec.get("paths") or {}
    summary = []
    for path, item in sorted(paths.items()):
        if not isinstance(item, dict):
            continue
        for method, op in item.items():
            if method.startswith("x-") or not isinstance(op, dict):
                continue
            if method.lower() not in ("get", "post", "put", "patch", "delete"):
                continue
            summary.append(
                {
                    "method": method.upper(),
                    "path": path,
                    "operationId": op.get("operationId"),
                    "summary": op.get("summary") or op.get("description", "")[:160],
                    "tags": op.get("tags"),
                }
            )
    return {"base": DEFAULT_BASE, "count": len(summary), "operations": summary}


def find_ops(spec: dict, *needles: str) -> list[dict]:
    """Find operations whose path/summary/operationId match all needles (case-insensitive)."""
    ops = summarize_paths(spec)["operations"]
    out = []
    for op in ops:
        blob = f"{op['method']} {op['path']} {op.get('operationId') or ''} {op.get('summary') or ''}".lower()
        if all(n.lower() in blob for n in needles):
            out.append(op)
    return out


def get_request_body_schema(spec: dict, method: str, path: str) -> Any:
    item = (spec.get("paths") or {}).get(path) or {}
    op = item.get(method.lower()) or item.get(method.upper())
    if not isinstance(op, dict):
        return None
    rb = op.get("requestBody") or {}
    content = rb.get("content") or {}
    for ctype in ("application/json", "application/merge-patch+json"):
        if ctype in content:
            return expand_schema(spec, content[ctype].get("schema"))
    # first content schema
    for _ctype, cval in content.items():
        if isinstance(cval, dict) and "schema" in cval:
            return expand_schema(spec, cval.get("schema"))
    return None


def get_response_schema(spec: dict, method: str, path: str, status: str = "200") -> Any:
    item = (spec.get("paths") or {}).get(path) or {}
    op = item.get(method.lower()) or item.get(method.upper())
    if not isinstance(op, dict):
        return None
    responses = op.get("responses") or {}
    # prefer exact, then 201/202
    for code in (status, "201", "202", "200"):
        if code not in responses:
            continue
        r = responses[code] or {}
        content = r.get("content") or {}
        for ctype, cval in content.items():
            if isinstance(cval, dict) and "schema" in cval:
                return expand_schema(spec, cval.get("schema"))
    return None


def analyze_record_and_job_schemas(spec: dict, out_dir: Path) -> dict[str, Any]:
    """Extract confirmed facts about dataset types, record fields, successCriteria, metrics."""
    report: dict[str, Any] = {
        "dataset_create": {},
        "records_add": {},
        "job_create": {},
        "evaluators": {},
        "score_hints": {},
        "warnings": [],
    }

    # Dataset create
    create_ds = find_ops(spec, "post", "dataset")
    # Prefer path that looks like POST .../datasets without trailing id
    create_ds = [o for o in create_ds if o["method"] == "POST" and re.search(r"/datasets/?$", o["path"])]
    if not create_ds:
        create_ds = [o for o in find_ops(spec, "post") if "dataset" in o["path"].lower() and "{" not in o["path"]]
    if create_ds:
        op = create_ds[0]
        schema = get_request_body_schema(spec, op["method"], op["path"])
        report["dataset_create"] = {
            "operation": op,
            "property_names": sorted(schema_prop_names(schema)),
            "datasetType_enum": find_enum(schema, "datasetType") or find_enum(schema, "type"),
            "schema": schema,
        }
    else:
        report["warnings"].append("No POST create-dataset operation found in OpenAPI paths.")

    # Add records
    add_rec = [
        o
        for o in find_ops(spec, "post", "record")
        if "dataset" in o["path"].lower()
    ]
    if not add_rec:
        add_rec = [o for o in summarize_paths(spec)["operations"] if o["method"] == "POST" and "record" in o["path"].lower()]
    if add_rec:
        op = add_rec[0]
        schema = get_request_body_schema(spec, op["method"], op["path"])
        # Drill into records items if present
        items_schema = None
        if isinstance(schema, dict):
            props = schema.get("properties") or {}
            rec = props.get("records") or props.get("items")
            if isinstance(rec, dict):
                items_schema = rec.get("items") if rec.get("type") == "array" or "items" in rec else rec
                items_schema = expand_schema(spec, items_schema) if items_schema else None
        prop_names = sorted(schema_prop_names(items_schema) | schema_prop_names(schema))
        report["records_add"] = {
            "operation": op,
            "request_property_names": sorted(schema_prop_names(schema)),
            "record_property_names": sorted(schema_prop_names(items_schema)) if items_schema else sorted(schema_prop_names(schema)),
            "recordType_enum": find_enum(items_schema, "recordType") or find_enum(schema, "recordType"),
            "supports_expectedOutput": "expectedOutput" in prop_names or "expected_output" in prop_names or "expectedResponse" in prop_names,
            "supports_expectedTools": "expectedTools" in prop_names or "expected_tools" in prop_names or "expectedToolCalls" in prop_names,
            "supports_metadata": "metadata" in prop_names,
            "supports_messages": "messages" in prop_names,
            "schema": schema,
            "record_item_schema": items_schema,
        }
        # multi-turn: messages is array of role/content
        msg = None
        if isinstance(items_schema, dict):
            msg = (items_schema.get("properties") or {}).get("messages")
        report["records_add"]["messages_schema"] = expand_schema(spec, msg) if msg else None
    else:
        report["warnings"].append("No add-records POST found in OpenAPI.")

    # Create job
    create_job = [o for o in find_ops(spec, "post", "job") if o["method"] == "POST"]
    create_job = [o for o in create_job if re.search(r"/jobs/?$", o["path"])] or create_job
    if create_job:
        op = create_job[0]
        schema = get_request_body_schema(spec, op["method"], op["path"])
        props = sorted(schema_prop_names(schema))
        # Locate successCriteria schema
        sc = None
        if isinstance(schema, dict):
            sc = (schema.get("properties") or {}).get("successCriteria")
            sc = expand_schema(spec, sc) if sc else None
        report["job_create"] = {
            "operation": op,
            "property_names": props,
            "has_successCriteria": "successCriteria" in props,
            "has_assignee": "assignee" in props,
            "has_agentId": "agentId" in props or "agent_id" in props,
            "has_datasetId": "datasetId" in props or "dataset_id" in props,
            "type_enum": find_enum(schema, "type"),
            "successCriteria_schema": sc,
            "schema": schema,
        }
    else:
        report["warnings"].append("No POST create-job operation found in OpenAPI.")

    # Evaluators list + schema
    list_eval = [o for o in find_ops(spec, "get", "evaluator") if o["method"] == "GET" and "{" not in o["path"]]
    if list_eval:
        op = list_eval[0]
        resp = get_response_schema(spec, op["method"], op["path"])
        report["evaluators"] = {
            "list_operation": op,
            "response_schema": resp,
            "response_property_names": sorted(schema_prop_names(resp)),
        }
    else:
        report["warnings"].append("No GET list-evaluators operation found.")

    # Heuristic score scale notes from any metric schema descriptions
    blob = json.dumps(spec)
    scale_notes = []
    for pat, label in [
        (r"0\s*[–-]\s*1", "mentions 0-1"),
        (r"0\s*[–-]\s*100", "mentions 0-100"),
        (r"percentage", "mentions percentage"),
        (r"hallucination", "mentions hallucination"),
    ]:
        if re.search(pat, blob, re.I):
            scale_notes.append(label)
    report["score_hints"]["openapi_text_matches"] = scale_notes
    report["score_hints"]["note"] = (
        "Do not assume 0.05 vs 5% until evaluator outputMetrics / successCriteria schema is inspected "
        "from live GET /evaluators and OpenAPI successCriteria."
    )

    save_json(out_dir / "schema-analysis.json", report)
    return report


def pick_list_get(spec: dict, *needles: str) -> dict | None:
    ops = [o for o in find_ops(spec, "get", *needles) if o["method"] == "GET" and "{" not in o["path"]]
    return ops[0] if ops else None


def materialize_path(path_template: str, **vars: str) -> str:
    def repl(m: re.Match) -> str:
        name = m.group(1)
        if name not in vars:
            raise KeyError(name)
        return vars[name]

    return re.sub(r"\{([^}]+)\}", repl, path_template)


def live_readonly(token: str, spec: dict, out_dir: Path) -> dict[str, Any]:
    """Call confirmed GET list endpoints only."""
    results: dict[str, Any] = {}
    targets = [
        ("datasets", ("dataset",)),
        ("evaluators", ("evaluator",)),
        ("jobs", ("job",)),
        ("results", ("result",)),
    ]
    for key, needles in targets:
        op = pick_list_get(spec, *needles)
        if not op:
            # fallback: path contains plural key
            candidates = [
                o
                for o in summarize_paths(spec)["operations"]
                if o["method"] == "GET" and key in o["path"].lower() and "{" not in o["path"]
            ]
            op = candidates[0] if candidates else None
        if not op:
            results[key] = {"skipped": True, "reason": "no matching GET in OpenAPI"}
            continue
        url = DEFAULT_BASE + op["path"]
        # pageSize if query allows — only add if OpenAPI lists it
        item = (spec.get("paths") or {}).get(op["path"]) or {}
        get_op = item.get("get") or {}
        params = get_op.get("parameters") or []
        q = []
        for p in params:
            if not isinstance(p, dict):
                continue
            if p.get("in") == "query" and p.get("name") in ("pageSize", "page_size", "limit"):
                q.append(f"{p['name']}=20")
                break
        if q:
            url = url + ("&" if "?" in url else "?") + q[0]
        status, _hdrs, body = http("GET", url, token)
        results[key] = {"operation": op, "url": url, "status": status, "body": body}
        save_json(out_dir / f"live-{key}.json", results[key])
        print(f"  GET {op['path']} -> {status}")
    return results


def print_analysis(report: dict) -> None:
    print("\n=== Schema analysis (from OpenAPI only) ===")
    ds = report.get("dataset_create") or {}
    if ds.get("datasetType_enum") is not None:
        print(f"datasetType enum: {ds.get('datasetType_enum')}")
    else:
        print("datasetType enum: (not found on create schema — check schema dump)")
    print(f"create dataset properties: {ds.get('property_names')}")

    rec = report.get("records_add") or {}
    print(f"add-records op: {rec.get('operation')}")
    print(f"record properties: {rec.get('record_property_names')}")
    print(f"  expectedOutput/response: {rec.get('supports_expectedOutput')}")
    print(f"  expectedTools:           {rec.get('supports_expectedTools')}")
    print(f"  metadata:                {rec.get('supports_metadata')}")
    print(f"  messages (multi-turn):   {rec.get('supports_messages')}")
    print(f"  recordType enum:         {rec.get('recordType_enum')}")

    job = report.get("job_create") or {}
    print(f"create-job properties: {job.get('property_names')}")
    print(f"  successCriteria present: {job.get('has_successCriteria')}")
    print(f"  type enum: {job.get('type_enum')}")
    if job.get("successCriteria_schema"):
        print("  successCriteria schema keys:", sorted(schema_prop_names(job["successCriteria_schema"])))
        sc = job["successCriteria_schema"]
        print("  successCriteria schema (truncated):", json.dumps(sc, default=str)[:800])

    for w in report.get("warnings") or []:
        print("WARN:", w)
    print("Score scale:", (report.get("score_hints") or {}).get("note"))


def map_wa_cases_to_records(cases: list[dict], record_props: set[str], record_type: str | None) -> list[dict]:
    """Map local WA JSON into API records using only properties confirmed by OpenAPI."""
    records = []
    for case in cases:
        rec: dict[str, Any] = {}
        # recordType
        for key in ("recordType", "record_type", "type"):
            if key in record_props:
                rec[key] = record_type or case.get("recordType") or "CONVERSATION"
                break
        if "messages" in record_props and "messages" in case:
            rec["messages"] = case["messages"]
        # expected output aliases
        for src, aliases in [
            ("expectedOutput", ("expectedOutput", "expected_output", "expectedResponse", "expected_response")),
            ("expectedTools", ("expectedTools", "expected_tools", "expectedToolCalls", "expected_tool_calls")),
            ("metadata", ("metadata",)),
        ]:
            if src not in case:
                continue
            for a in aliases:
                if a in record_props:
                    rec[a] = case[src]
                    break
        # drop unknown — already only set known props
        records.append(rec)
    return records


def smoke_evaluate(
    token: str,
    spec: dict,
    analysis: dict,
    out_dir: Path,
    agent_id: str,
    suite_name: str,
    cases_file: Path,
    evaluator_id: str | None,
) -> None:
    """
    Minimal non-production eval. Aborts unless OpenAPI confirmed the needed operations
    and required fields. Does not guess successCriteria thresholds.
    """
    ds_op = (analysis.get("dataset_create") or {}).get("operation")
    rec_op = (analysis.get("records_add") or {}).get("operation")
    job_op = (analysis.get("job_create") or {}).get("operation")
    if not (ds_op and rec_op and job_op):
        raise SystemExit("Smoke eval aborted: create dataset/records/job ops not all present in OpenAPI.")

    ds_schema = analysis["dataset_create"].get("schema") or {}
    ds_props = set(analysis["dataset_create"].get("property_names") or [])
    type_enum = analysis["dataset_create"].get("datasetType_enum") or []

    # Choose dataset type strictly from enum + case shape
    cases = json.loads(cases_file.read_text())
    if not isinstance(cases, list) or not cases:
        raise SystemExit("cases file must be a non-empty JSON array")

    multi_turn = any(len((c.get("messages") or [])) > 1 for c in cases)
    # Prefer QUERY/single-prompt type for single-turn if enum offers it; else CONVERSATION.
    chosen_type = None
    if type_enum:
        upper = {str(x).upper(): x for x in type_enum}
        if multi_turn:
            chosen_type = upper.get("CONVERSATION") or type_enum[0]
        else:
            for candidate in ("QUERY", "PROMPT", "SINGLE_TURN", "SINGLE_PROMPT", "CONVERSATION"):
                if candidate in upper:
                    chosen_type = upper[candidate]
                    break
            chosen_type = chosen_type or type_enum[0]
    print(f"datasetType chosen from enum={type_enum!r} multi_turn={multi_turn} -> {chosen_type!r}")

    create_body: dict[str, Any] = {}
    if "name" in ds_props:
        create_body["name"] = suite_name
    if "datasetType" in ds_props and chosen_type is not None:
        create_body["datasetType"] = chosen_type
    elif "type" in ds_props and chosen_type is not None:
        create_body["type"] = chosen_type
    if "description" in ds_props:
        create_body["description"] = (
            "Non-production discovery smoke dataset for Work Assist regression. Safe to delete."
        )

    # kbLibraryLinks required in docs screenshot — only set if required by schema
    required = []
    if isinstance(ds_schema, dict):
        required = list(ds_schema.get("required") or [])
        for part in ds_schema.get("allOf") or []:
            if isinstance(part, dict):
                required.extend(part.get("required") or [])
    if "kbLibraryLinks" in required or "kbLibraryLinks" in ds_props:
        links = os.environ.get("EVALS_KB_LIBRARY_LINKS", "")
        if not links and "kbLibraryLinks" in required:
            raise SystemExit(
                "OpenAPI/schema indicates kbLibraryLinks is required. "
                "Set EVALS_KB_LIBRARY_LINKS=uuid1,uuid2 from your KB libraries."
            )
        if links:
            create_body["kbLibraryLinks"] = [x.strip() for x in links.split(",") if x.strip()]
        elif "kbLibraryLinks" in ds_props and "kbLibraryLinks" not in required:
            # omit optional empty
            pass

    missing_req = [r for r in required if r not in create_body]
    if missing_req:
        raise SystemExit(
            f"Cannot build create-dataset body; missing required fields {missing_req}. "
            f"Known props={sorted(ds_props)}. Provide via env or extend script after inspecting schema-analysis.json"
        )

    # Create dataset
    url = DEFAULT_BASE + ds_op["path"]
    status, hdrs, body = http("POST", url, token, create_body)
    save_json(out_dir / "smoke-create-dataset.json", {"status": status, "headers": hdrs, "body": body, "request": create_body})
    if status not in (200, 201):
        raise SystemExit(f"Create dataset failed: {status} {body}")
    dataset_id = body.get("id") if isinstance(body, dict) else None
    if not dataset_id:
        raise SystemExit(f"No dataset id in response: {body}")
    print(f"Created dataset {dataset_id}")

    # Add ONE record only for minimal smoke (first case)
    rec_props = set(analysis["records_add"].get("record_property_names") or [])
    rt_enum = analysis["records_add"].get("recordType_enum")
    record_type = None
    if rt_enum:
        # align with dataset type when possible
        upper = {str(x).upper(): x for x in rt_enum}
        record_type = upper.get(str(chosen_type).upper()) or rt_enum[0]
    mapped = map_wa_cases_to_records(cases[:1], rec_props, record_type)
    add_schema_props = set(analysis["records_add"].get("request_property_names") or [])
    if "records" in add_schema_props:
        add_body: Any = {"records": mapped}
    else:
        add_body = mapped[0] if len(mapped) == 1 and "messages" in add_schema_props else {"records": mapped}

    add_path = materialize_path(rec_op["path"], dataset_id=dataset_id, datasetId=dataset_id)
    status, hdrs, body = http("POST", DEFAULT_BASE + add_path, token, add_body)
    save_json(out_dir / "smoke-add-records.json", {"status": status, "request": add_body, "body": body})
    if status not in (200, 201):
        raise SystemExit(f"Add records failed: {status} {body}")
    print("Added 1 smoke record")

    # Build job body — only fields present in schema; successCriteria only if we can copy
    # a template from a live evaluator or env JSON (no invented thresholds).
    job_props = set(analysis["job_create"].get("property_names") or [])
    job_body: dict[str, Any] = {}
    if "type" in job_props:
        type_enum = analysis["job_create"].get("type_enum") or ["EVALUATE_AGENT"]
        if "EVALUATE_AGENT" in type_enum or not analysis["job_create"].get("type_enum"):
            job_body["type"] = "EVALUATE_AGENT"
        else:
            job_body["type"] = type_enum[0]
    if "name" in job_props:
        job_body["name"] = f"SMOKE {suite_name}"
    if "description" in job_props:
        job_body["description"] = "Minimal discovery smoke — delete after validation."
    if "agentId" in job_props:
        job_body["agentId"] = agent_id
    elif "agent_id" in job_props:
        job_body["agent_id"] = agent_id
    if "datasetId" in job_props:
        job_body["datasetId"] = dataset_id
    elif "dataset_id" in job_props:
        job_body["dataset_id"] = dataset_id

    # assignee / evaluator
    if not evaluator_id:
        # try live evaluators list for a hallucination or prompt alignment system template
        live_ev = out_dir / "live-evaluators.json"
        if live_ev.is_file():
            data = json.loads(live_ev.read_text())
            items = (data.get("body") or {}).get("items") or data.get("body") or []
            if isinstance(items, dict):
                items = items.get("items") or []
            for it in items if isinstance(items, list) else []:
                name = (it.get("name") or "").lower()
                if "hallucination" in name or "prompt alignment" in name:
                    evaluator_id = it.get("id")
                    print(f"Picked evaluator from live list: {it.get('name')} ({evaluator_id})")
                    # capture outputMetrics for scale
                    save_json(out_dir / "smoke-picked-evaluator.json", it)
                    break
            if not evaluator_id and items:
                evaluator_id = items[0].get("id")
                print(f"Fallback first evaluator: {items[0].get('name')} ({evaluator_id})")
                save_json(out_dir / "smoke-picked-evaluator.json", items[0])
    if "assignee" in job_props:
        if not evaluator_id:
            raise SystemExit(
                "Job schema requires assignee/evaluator but none provided. "
                "Re-run discovery live lists, or pass --evaluator-id."
            )
        actor = evaluator_id if str(evaluator_id).startswith("evaluator:") else f"evaluator:{evaluator_id}"
        job_body["assignee"] = {"actors": [actor]}

    # successCriteria: ONLY from env JSON file matching schema — never invent 0.05 vs 5
    sc_env = os.environ.get("EVALS_SUCCESS_CRITERIA_JSON")
    sc_file = os.environ.get("EVALS_SUCCESS_CRITERIA_FILE")
    if analysis["job_create"].get("has_successCriteria"):
        if sc_file:
            job_body["successCriteria"] = json.loads(Path(sc_file).read_text())
        elif sc_env:
            job_body["successCriteria"] = json.loads(sc_env)
        else:
            print(
                "NOTE: OpenAPI includes successCriteria but no EVALS_SUCCESS_CRITERIA_JSON/FILE set.\n"
                "Omitting successCriteria for smoke (if API requires it, job will fail and we capture body)."
            )

    job_required = []
    js = analysis["job_create"].get("schema") or {}
    if isinstance(js, dict):
        job_required = list(js.get("required") or [])
    missing = [r for r in job_required if r not in job_body]
    if missing:
        raise SystemExit(f"Job body missing required {missing}. Inspect schema-analysis.json and supply env overrides.")

    status, hdrs, body = http("POST", DEFAULT_BASE + job_op["path"], token, job_body)
    save_json(out_dir / "smoke-create-job.json", {"status": status, "headers": dict(hdrs), "request": job_body, "body": body})
    if status not in (200, 201, 202):
        raise SystemExit(f"Create job failed: {status} {body}")
    job_id = body.get("id") if isinstance(body, dict) else None
    print(f"Job accepted: {job_id} status={body.get('status') if isinstance(body, dict) else status}")

    # Poll get-job if present
    get_job = [
        o
        for o in summarize_paths(spec)["operations"]
        if o["method"] == "GET" and "{job" in o["path"].lower().replace("_", "")
        or (o["method"] == "GET" and re.search(r"/jobs/\{[^}]+\}", o["path"]))
    ]
    # cleaner filter
    get_job = [
        o
        for o in summarize_paths(spec)["operations"]
        if o["method"] == "GET" and re.search(r"/jobs/\{[^}]+\}", o["path"])
    ]
    if get_job and job_id:
        gpath = materialize_path(get_job[0]["path"], job_id=job_id, jobId=job_id, id=job_id)
        for i in range(60):
            st, _h, jb = http("GET", DEFAULT_BASE + gpath, token)
            save_json(out_dir / "smoke-job-status.json", {"status_code": st, "body": jb, "poll": i})
            jstatus = (jb or {}).get("status") if isinstance(jb, dict) else None
            print(f"  poll {i}: http={st} job.status={jstatus}")
            if jstatus and str(jstatus).upper() in ("COMPLETED", "SUCCEEDED", "FAILED", "CANCELLED", "COMPLETE", "DONE"):
                break
            time.sleep(10)

    # List results filtered by job if query param exists
    list_res = [
        o
        for o in summarize_paths(spec)["operations"]
        if o["method"] == "GET" and "result" in o["path"].lower() and "{" not in o["path"]
    ]
    if list_res and job_id:
        item = (spec.get("paths") or {}).get(list_res[0]["path"]) or {}
        params = (item.get("get") or {}).get("parameters") or []
        qnames = {p.get("name") for p in params if isinstance(p, dict) and p.get("in") == "query"}
        url = DEFAULT_BASE + list_res[0]["path"]
        if "jobId" in qnames:
            url += f"?jobId={job_id}"
        elif "job_id" in qnames:
            url += f"?job_id={job_id}"
        st, _h, rb = http("GET", url, token)
        save_json(out_dir / "smoke-results.json", {"status": st, "url": url, "body": rb})
        print(f"Results GET -> {st}")


def main() -> None:
    _load_dotenv(SCRIPT_DIR / ".env.local")
    _load_dotenv(SCRIPT_DIR / ".env")

    ap = argparse.ArgumentParser(description="Discover Trimble Evals API from OpenAPI")
    ap.add_argument("--no-live", action="store_true", help="Skip authenticated list GETs")
    ap.add_argument("--openapi-file", help="Local OpenAPI JSON/YAML instead of fetching")
    ap.add_argument("--openapi-url", help="Exact OpenAPI URL")
    ap.add_argument("--out-dir", default=str(SCRIPT_DIR / "discovery-out"))
    ap.add_argument("--smoke-evaluate", action="store_true", help="Run ONE minimal evaluate job after discovery")
    ap.add_argument("--agent-id", default=os.environ.get("WORK_ASSIST_AGENT_ID", "37242c15-9716-4b91-9032-e8f7390d1d80"))
    ap.add_argument("--suite-name", default="WA-05 Source Priority Regression")
    ap.add_argument("--cases-file", default=str(SCRIPT_DIR.parent / "WA-05-Source-Priority.json"))
    ap.add_argument("--evaluator-id", default=os.environ.get("EVALS_EVALUATOR_ID"))
    args = ap.parse_args()

    out_dir = Path(args.out_dir) / _utc()
    out_dir.mkdir(parents=True, exist_ok=True)
    print(f"Output: {out_dir}")

    token = None
    if not args.openapi_file or not args.no_live or args.smoke_evaluate:
        try:
            token = get_token()
            print("Auth: token acquired")
        except SystemExit as e:
            if args.openapi_file and args.no_live and not args.smoke_evaluate:
                print(f"Auth skipped ({e})")
            else:
                raise

    spec = load_openapi(token, out_dir, args.openapi_file, args.openapi_url)
    paths_summary = summarize_paths(spec)
    save_json(out_dir / "paths-summary.json", paths_summary)
    print(f"OpenAPI operations: {paths_summary['count']}")

    analysis = analyze_record_and_job_schemas(spec, out_dir)
    print_analysis(analysis)

    if not args.no_live:
        if not token:
            raise SystemExit("Live calls require auth token")
        print("\n=== Live read-only GETs (OpenAPI-confirmed list paths) ===")
        live_readonly(token, spec, out_dir)
        # Re-check evaluators for outputMetrics scale from live data
        live_ev = out_dir / "live-evaluators.json"
        if live_ev.is_file():
            body = json.loads(live_ev.read_text()).get("body")
            items = []
            if isinstance(body, dict):
                items = body.get("items") or []
            elif isinstance(body, list):
                items = body
            metrics_report = []
            for it in items[:30]:
                if not isinstance(it, dict):
                    continue
                metrics_report.append(
                    {
                        "id": it.get("id"),
                        "name": it.get("name"),
                        "isSystemManaged": it.get("isSystemManaged"),
                        "outputMetrics": it.get("outputMetrics"),
                    }
                )
            save_json(out_dir / "evaluators-metrics-excerpt.json", metrics_report)
            print(f"  evaluator metrics excerpt: {len(metrics_report)} items")

    save_json(
        out_dir / "discovery-summary.json",
        {
            "base": DEFAULT_BASE,
            "generatedAt": _utc(),
            "pathsCount": paths_summary["count"],
            "analysisWarnings": analysis.get("warnings"),
            "recordSupport": {
                k: analysis.get("records_add", {}).get(k)
                for k in (
                    "supports_expectedOutput",
                    "supports_expectedTools",
                    "supports_metadata",
                    "supports_messages",
                    "recordType_enum",
                )
            },
            "datasetType_enum": analysis.get("dataset_create", {}).get("datasetType_enum"),
            "jobHasSuccessCriteria": analysis.get("job_create", {}).get("has_successCriteria"),
        },
    )

    if args.smoke_evaluate:
        if not token:
            raise SystemExit("--smoke-evaluate requires auth")
        print("\n=== Smoke EVALUATE_AGENT (1 record) ===")
        smoke_evaluate(
            token,
            spec,
            analysis,
            out_dir,
            agent_id=args.agent_id,
            suite_name=args.suite_name,
            cases_file=Path(args.cases_file),
            evaluator_id=args.evaluator_id,
        )

    print("\nDone. Review schema-analysis.json before building a regression runner.")
    print("Do not assume score thresholds until evaluators-metrics-excerpt.json / successCriteria schema are clear.")


if __name__ == "__main__":
    main()
