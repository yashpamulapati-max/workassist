# Packaging WorkAssist Agent for AgileAssets Application

Standalone productization pack. Independent of the Oklahoma `ams-ok-yp2` demo snapshot
in [`embed/`](../embed/) and the recovery files in [`ops/`](../ops/).

How to go from the hand-install to something any AgileAssets application can turn on —
and what Trimble product should own.

Live proof today is **not** a product drop-in: five Kernel files plus a patched TID
scope, copied into a running Tomcat pod. Recreate the pod and the FAB is gone.
Agent id, Oklahoma menu catalog, and stage embed host are hardcoded.

Tracking: [workassist project](https://github.com/users/yashpamulapati-max/projects/1).

---

## What WorkAssist Agent actually is

Two independently versioned pieces. Shipping only the JS, or only a Studio agent,
is not enough.

### A. Trimble Agent Studio (cloud)

The brain: instructions, knowledge, evals, Web Search, Confluence, Jira. Lives on
stage/prod Agent Service. Survives AMS pod recycles.

Current: Work Assist `37242c15-9716-4b91-9032-e8f7390d1d80` on stage. One shared
agent is fine for a demo; product tenants usually **clone a template** so
instructions and KB can be agency-specific.

### B. AMS embed (in the WAR)

The hands: FAB, finder, Diagnostics, host tools (DOM, REST, `search_windows` /
`open_window`), official iframe SDK, TID token bridge.

Current: `kubectl cp` into `Kernel/`. Must be baked into `ams-web` and configured
per env (agent id, embed host, catalog). Demo snapshot (not this pack):
[`embed/Kernel/`](../embed/Kernel/) (`v=20260817d`).

---

## What a new AgileAssets app must have

Minimum for “the FAB loads an agent that can open windows and call REST as the
signed-in user.”

| Requirement | Why | Who sets it |
| --- | --- | --- |
| TID SSO login (`w_sso_user.jsp`) | Classic login has no Trimble Identity token. Iframe auth fails. | Env / customer IAM |
| TID client entitled to `agents` scope | Missing scope → Failed to load agent. Append to existing `OPS_…` / `AMS_TID_*` value. | TID + Helm `${aa.tidScope}` |
| Iframe host `embed.*` not `assist.*` | `assist.stage` sends `X-Frame-Options: DENY`. SDK uses `embed.stage` / `embed.ai.trimble.com`. | Embed package (fixed) |
| Kernel inject after `w_gvars.jsp` | Needs `GVars.access_token` and `aa_sid`. Script order: sdk → assist.js. | `ams-web` `w_main.jsp` |
| Agent id + env (`stage` \| `prod`) | Must not stay hardcoded to the OK demo agent for every customer. | Helm / GVars / config JSON |
| Window catalog from **this** database | OK 563-row JSON is wrong on another client. `menu_id` is per `SYSTEM_MENU`. | Build job or runtime query |

### Do not copy from yp2

- **yp2 `web.xml`** — JDBC, TID client ids, encrypted secrets. Another env has its own. Only the pattern matters: keep existing scope, append `agents`.
- **Oklahoma FAQ stats** — Mandatory Q1 2025 numbers and OK-only conversation starters stay in that agent’s instructions, not in the embed JAR.
- **`kubectl cp` runbook** — Fine for a lab. Product install is a WAR + Helm flag. Pod recycle must not wipe the assistant.

---

## Ship as three packages

The AgileAssets application owns the embed. Trimble AI owns the agent template.
Ops/Helm owns the per-env switch. That split is what makes “anyone can add it” real.

### 1. Embed in the product image (`ams-web`)

**Contents:** `trimble-sdk.js`, `trimble-assist.js`, `trimble-assist.css`, tags in
`w_main.jsp` (merge, do not overwrite a newer shell). Optional empty catalog JSON
as fallback.

**Config (not hardcoded):** Read agent id, env, theme, enabled flag from GVars or
`Kernel/trimble-assist-config.json` generated at deploy. Default **off** until Helm
sets `aa.workassist.enabled=true`.

**Scope:** Helm/configmap: `${aa.tidScope} = existing_value + " agents"`. Never set
a duplicate `OPENID_SCOPE` env — it double-applies the SSO filter.

Related board item: *Permanent fix: agents scope + embed files survive pod recreation*.

### 2. Template agent (clone, don’t share one id)

Export the Work Assist instructions (minus OK-only FAQ numbers), description
one-liner, knowledge-library links, eval sets WA-01 / WA-03 / WA-06 as the starter
pack. Customer or implementation clones it in Studio, gets a new agent id, pastes
that id into Helm.

Shared demo agent is OK for internal AMS_OK. Customer prod should not all point at
`37242c15-…`.

### 3. Catalog + enablement (per tenant)

Generate `trimble-assist-menus.json` from `SYSTEM_MENU` (Helper already has the
Oracle query). Prefer a small AMS endpoint or a dbupdater job over shipping OK CSV.
Roadway Day Cards id is not always `3_wo_daycards`.

Entitlements: TID client allowed to request `agents`. Users on TID SSO. Feature
flag so a tenant can disable the FAB.

---

## Install checklist for another AMS env

Same as the yp3 recovery runbook, treated as the customer path until the WAR bake
lands. Lab steps (yp2-specific): [`ops/ams-ok-sso-pod-restart.md`](../ops/ams-ok-sso-pod-restart.md).

| Step | Action | Done when |
| --- | --- | --- |
| 1. Auth | Confirm TID SSO URL works. Classic `w_login.jsp` is not enough. | `GVars.access_token` is a TID JWT |
| 2. Scope | Pull that pod’s `web.xml`. Append `agents` to the active `TrimbleIdentitySsoFilter` `openIdScope`. Save under `ops/<ns>/`. | Token includes `agents` after re-login |
| 3. Embed | Copy sdk + js + css. Merge script tags into **this** image’s `w_main.jsp`. | Console: `[WorkAssist] Loaded v=…` |
| 4. Agent | Set `agentId` / env. Clone template or reuse stage Work Assist for internal demos. | Agent loads, not “Failed to load agent” |
| 5. Catalog | Export `SYSTEM_MENU` for that DB. Replace OK JSON. Update Studio notes for module ids. | Finder + “take me to…” open the right window |
| 6. Verify | FAB, persist across window change, Diagnostics, hard-refresh cache-bust. | `window catalog=N` for that client |

---

## Recommended product shape

| Now (summit / labs) | Next (AgileAssets application) | Then (customer GA) |
| --- | --- | --- |
| Keep `kubectl cp` + `ops/<ns>/web.xml`. Document the six steps. Do not pretend this is GA. | PR into `ams-web`: files in Kernel, `w_main.jsp` behind a flag, Helm `tidScope` + `workassist.agentId`. Catalog job from `SYSTEM_MENU`. | Studio marketplace template. Per-tenant agent clone. FF4J/GVars toggle. No OK-specific instructions in the default agent. |

### Leave out of the product package

Cursor MCP server, Oracle SQL tools, ngrok/public MCP ingress, Helper form editor /
log styler / heap gauges, and the hidden-iframe log fetch (reverted — it breaks AMS).
Those are developer or Chrome-extension paths, not the in-app assistant.

---

## Config surface to add in ams-web

| Key | Example | Notes |
| --- | --- | --- |
| `aa.workassist.enabled` | `true` | Off by default in the WAR |
| `aa.workassist.agentId` | uuid | From cloned Studio agent |
| `aa.workassist.env` | `stage` \| `prod` | Selects `embed.stage` vs `embed.ai.trimble.com` |
| `aa.workassist.theme` | `dark` | Optional |
| `aa.tidScope` | `OPS_… agents` | Append `agents`; keep existing OPS/AMS_TID value |

---

## Related in this repo

| Path | Role |
| --- | --- |
| [`embed/`](../embed/) | Current yp2 Kernel snapshot — demo, not the product pack |
| [`ops/`](../ops/) | yp2 recovery runbook + patched `web.xml` |
| [`evals/`](../evals/) | Studio eval sets |
| [`docs/TRIMBLE-AGENTIC-AI-SETUP.md`](../docs/TRIMBLE-AGENTIC-AI-SETUP.md) | Integration reference |
| [`docs/session-notes/2026-08-21-packaging.md`](../docs/session-notes/2026-08-21-packaging.md) | Session that produced this pack |
