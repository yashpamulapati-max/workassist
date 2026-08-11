# Trimble Agentic AI Assist — AgileAssets Integration Guide

A complete step-by-step record of how we integrated Trimble's Agentic AI platform with the AgileAssets web application, enabling an AI assistant that can query and modify live application data through natural language.

---

## Changelog

- **2026-08-07** — Replicated the embed on the `ams-ok-yp2` environment and made it fully work end-to-end. Key additions this round:
  - **Fixed the blank iframe**: `assist.stage.trimble-ai.com` returns `X-Frame-Options: DENY`. The official SDK embeds from the frameable **`embed.*.trimble-ai.com`** domains instead. See [Part D](#6-part-d-iframe-embedding-in-agileassets).
  - **Bundled the official iframe SDK** (`@trimble-agentic-external-npm-local/agentic-platform-sdk-iframe-typescript` v1.3.0) into a browser IIFE (`trimble-sdk.js`, `window.TrimbleAgenticSDK`) via esbuild, since AgileAssets' AngularJS/Vue build can't consume the ESM package directly.
  - **Fixed "Failed to load agent"**: the TID token was missing the **`agents`** scope. Scope is set per-environment via the `openIdScope` **web.xml init-param** (not just `getDefaultScope()`). See [Part C](#5-part-c-trimble-agent-studio-configuration) and [Troubleshooting](#10-troubleshooting).
  - **Fixed the ~30s "slow answer" + tools not reaching the agent**: the SDK validates every tool definition with a Zod schema where `parameters.required` is **mandatory**; a single non-conforming tool made the child reject the entire `onBeforeRun` response and fall back to the 30s timeout with no tools/context. Added an `ensureToolSchemas()` normalizer and switched `onBeforeRun` to the **provider-function** form.
  - **Added DOM-interaction local tools** (`dom_get_page_context`, `dom_read_grid`, `dom_click_action`, `dom_set_field`, `dom_save`, `create_work_order_daycard`, etc.) alongside the REST/MCP tools.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Prerequisites](#2-prerequisites)
3. [Part A: AgileAssets REST API Authentication](#3-part-a-agileassets-rest-api-authentication)
4. [Part B: Cursor MCP Server (Developer Tooling)](#4-part-b-cursor-mcp-server-developer-tooling)
5. [Part C: Trimble Agent Studio Configuration](#5-part-c-trimble-agent-studio-configuration)
6. [Part D: Iframe Embedding in AgileAssets](#6-part-d-iframe-embedding-in-agileassets)
7. [Part E: Kubernetes Deployment](#7-part-e-kubernetes-deployment)
8. [Part F: Connecting Additional Data Sources](#8-part-f-connecting-additional-data-sources)
9. [File Reference](#9-file-reference)
10. [Troubleshooting](#10-troubleshooting)

---

## 1. Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│  Developer (Cursor IDE)                                      │
│                                                              │
│   Cursor Agent ──► agile-assets-api MCP ──► REST API         │
│                ──► oracle-sqlcl MCP ──────► Oracle DB         │
│                ──► jira-trimble MCP ──────► Jira              │
│                ──► confluence MCP ────────► Confluence         │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│  AgileAssets Web App (End Users)                             │
│                                                              │
│   ┌────────────────────────────────────────────────────┐     │
│   │  Trimble AI Assist (iframe)                        │     │
│   │  Agent: PromptPatrol                               │     │
│   │                                                    │     │
│   │  ──► Local Tools (postMessage) ──► REST API        │     │
│   │  ──► Knowledge Library ──────────► Confluence docs │     │
│   │  ──► MCP Tools ──────────────────► Database / APIs │     │
│   └────────────────────────────────────────────────────┘     │
│                                                              │
│   Bearer Token: GVars.access_token (from TID SSO)            │
│   Session ID:   GVars.aa_sid                                 │
└──────────────────────────────────────────────────────────────┘
```

Two integration paths were built:

- **Path 1 — Developer tooling**: A Python MCP server in Cursor IDE that lets the AI coding agent interact with AgileAssets REST API, Oracle DB, Jira, and Confluence.
- **Path 2 — End-user assistant**: Trimble Agentic AI (PromptPatrol) embedded as a floating chat panel inside the AgileAssets web application.

---

## 2. Prerequisites

| Item | Details |
|------|---------|
| Cursor IDE | Installed with MCP support |
| Python 3.13+ | Via Homebrew: `/opt/homebrew/bin/python3.13` |
| Node.js + npm | Needed only to build the SDK bundle (esbuild). Any recent LTS. |
| kubectl | Configured for EKS cluster `aa-dev-eks` in `us-east-2` |
| AWS OKTA auth | `aws_okta_keyman -o trimble -u <user>@am.trimblecorp.net --reup` |
| AgileAssets credentials | Username/password for the target environment |
| Trimble Identity (TID) | Account with access to Trimble Agent Studio |
| Trimble Agent Studio | Access to https://assist.stage.trimble-ai.com |
| Trimble Artifactory (npm) | Auth token in `.npmrc` to install the iframe SDK from `artifactory.trimble.tools` (see [Part D](#trimble-iframe-sdk--building-the-browser-bundle)) |

### Environments used

| Env / Namespace | Purpose | TID OAuth client (`openIdClientId`) | `openIdScope` (deployed) |
|-----------------|---------|-------------------------------------|--------------------------|
| `ams-ok-pp` | Original proof-of-concept embed | — | — |
| `ams-ok-yp2` | Current working env (demo target for AISummit 3.0, Aug 26) | `f69f789f-d964-430b-8bfe-2ba03251fd3d` | `OPS_prompt-patrol-env-2` (+ `agents`, see Part C) |

> **Note:** TID SSO login is **required** — Work Assist needs a Trimble Identity access token. Classic AgileAssets username/password login does not produce a TID token, so the iframe will render blank/errored for those sessions.

---

## 3. Part A: AgileAssets REST API Authentication

### How the API Works

AgileAssets uses OAuth2 for REST API authentication. The V2 API lives at:

```
https://<environment>/ams-web/rest/v2/
```

### Authentication Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/rest/v2/authenticate/login` | POST | Login and get bearer token |
| `/rest/v2/oauth2/token` | POST | OAuth2 token (password/refresh/auth_code grants) |
| `/rest/v2/oauth2/secret` | POST | Create OAuth2 client (one-time, requires admin) |

### Quick Start: Get a Bearer Token

```bash
AA_BASE_URL="https://ams-ok-yp-web.app.np.agileassets.net/ams-web"

curl -s -X POST "$AA_BASE_URL/rest/v2/authenticate/login" \
  -H "Content-Type: application/json" \
  -d '{"userName": "USERID", "password": "PASSWORD"}' | python3 -m json.tool
```

Response:

```json
{
    "data": [{
        "sessionId": "2f865791-ea2a-4145-b285-e7ecfefacce3",
        "oauth2Token": "$2a$12$SnNMw9HvdtZfzt/.arW1kOR...",
        "userId": "USERID",
        "userFullName": "User Name"
    }]
}
```

### Using the Token

```bash
curl -H "Authorization: Bearer $TOKEN" \
  "$AA_BASE_URL/rest/v2/workorders?limit=5"
```

### Token Lifecycle

| Token Type | Duration | Source |
|-----------|----------|--------|
| Access Token (API) | 12 hours | `Oauth2Constants.ACCESS_TOKEN_EXPIRES_IN = 43200` |
| Web Access Token | 31 days | `Oauth2Constants.WEB_ACCESS_TOKEN_EXPIRES_IN` |
| Refresh Token | 21 years | `Oauth2Constants.REFRESH_TOKEN_EXPIRES_IN` |

Token constants are in `ams-web/src/main/java/com/agileassetsinc/service/oauth2/Oauth2Constants.java`.

### Security Schemes (from Swagger)

The API supports five auth schemes (defined in `SwaggerServlet.java`):

1. **OAuth2 Password** — Resource Owner Password grant
2. **OAuth2 Application** — Client Credentials grant
3. **OAuth2 AccessCode** — Authorization Code grant
4. **AA_Session_id** — API key header `AA_SID`
5. **AA_Authentication** — Bearer token in `Authorization` header

### Swagger UI

Available at: `https://<environment>/ams-web/swagger/index.html`

Full security documentation: `ams-web/src/main/resources/swagger/security_description.md`

---

## 4. Part B: Cursor MCP Server (Developer Tooling)

### What Was Built

A Python MCP server (`agile-assets-mcp/server.py`) that exposes 41 tools for the Cursor AI agent to interact with AgileAssets.

### Setup

**1. Create virtual environment and install dependencies:**

```bash
cd agile-assets-mcp
/opt/homebrew/bin/python3.13 -m venv .venv
.venv/bin/pip install "mcp[cli]" httpx
```

**2. Register in `.cursor/mcp.json`:**

```json
{
  "mcpServers": {
    "agile-assets-api": {
      "command": "/Users/ypamula/agileassetsweb-project/agile-assets-mcp/.venv/bin/python3.13",
      "args": ["/Users/ypamula/agileassetsweb-project/agile-assets-mcp/server.py"],
      "env": {
        "AA_BASE_URL": "https://ams-ok-yp-web.app.np.agileassets.net/ams-web",
        "AA_USERNAME": "USERID",
        "AA_PASSWORD": "PASSWORD"
      }
    }
  }
}
```

**3. Restart Cursor** (Cmd+Shift+P → "Developer: Reload Window") and enable the `agile-assets-api` toggle in Cursor Settings → MCP.

### Available Tools (41 total)

**Work Requests:** `list_work_requests`, `get_work_request`, `create_work_request`, `update_work_request`, `delete_work_request`

**Work Orders:** `list_work_orders`, `get_work_order`, `create_work_order`, `update_work_order`, `delete_work_orders`

**Work Order Sub-resources:** `get_work_order_locations`, `add_work_order_locations`, `add_work_order_labor`, `add_work_order_equipment`, `add_work_order_materials`, `add_work_order_costs`, `add_work_order_accomplishments`

**Assets:** `list_assets`, `list_asset_types`, `list_asset_inspections`, `create_asset_inspection`

**Reference Data:** `get_lookups`, `list_activities`, `list_admin_units`, `list_crews`, `list_projects`

**Collections:** `list_collection_metadata`, `get_collection_data`, `create_collection_record`, `update_collection_record`

**Inventory:** `list_inventory_elements`, `list_routes`

**Generic API:** `api_get`, `api_post`, `api_put`, `api_delete`

**System:** `login`, `ping`, `get_system_settings`, `get_feature_toggles`, `list_users`

### How It Works

1. On startup, the server reads `AA_USERNAME` and `AA_PASSWORD` from environment variables
2. First API call triggers login via `/rest/v2/authenticate/login`
3. Bearer token is cached and auto-refreshed 5 minutes before the 12-hour expiry
4. All API calls use `Authorization: Bearer <token>` header
5. Cursor agent calls tools via MCP stdio protocol

---

## 5. Part C: Trimble Agent Studio Configuration

### Agent: PromptPatrol

| Setting | Value |
|---------|-------|
| Agent ID | `37242c15-9716-4b91-9032-e8f7390d1d80` |
| Environment | `stage` |
| URL | `assist.stage.trimble-ai.com/agent/37242c15-9716-4b91-9032-e8f7390d1d80` |
| Models | claude-opus-4-6 (Anthropic), gemini-3.1-flash-lite-preview (Google) |
| Knowledge Library | Agentic Knowledge Library |
| Tools | Datetime (built-in) + custom MCP/Local tools |

### Description

> AgileAssets AI Assist is an intelligent assistant embedded directly within the AgileAssets application, powered by Trimble's Agentic AI platform. It helps users navigate and perform AgileAssets workflows through natural language conversation. The assistant is trained on the complete AgileAssets Product Documentation knowledge base, covering Maintenance Manager, Fleet and Equipment Manager, Pavement Analyst, Structures Inspector, Signs Manager, Storm Water Manager, GIS Explorer, Safety Module, Reports, and System Administration. It queries live application data — work requests, work orders, assets, crews, and activities — directly from the AgileAssets REST API, creates and updates records on behalf of the user, and provides troubleshooting help using the Knowledge Base and FAQ.

### Instructions

The full agent instructions configure the AI to:
- Use correct AgileAssets terminology
- Reference documentation sources when answering
- Use `yyyyMMddHHmmss` date format for API calls
- Confirm with users before creating/updating records
- Leverage run context (user ID, admin unit, module)
- Provide menu paths for "how do I" questions

Full instructions are maintained in the Trimble Agent Studio "Configure Agent" form.

### Conversation Starters

1. "Compare labor, equipment, and material costs across all work orders in Division 1 for the last 6 months. Which activity type has the highest total cost?"
2. "Find all open work requests that have been in 'Supervisor to Schedule' status for more than 30 days and list them by admin unit."
3. "Create a work order for emergency pothole repair on a Section asset type, assign it to the appropriate crew in my admin unit."

### TID Scopes (IMPORTANT — this is what makes "Failed to load agent" go away)

The Trimble Agent Service requires the **`agents`** scope in the user's TID access token. If it's missing, the chat UI loads and lists agents, but the selected agent fails with **"Failed to load agent."**

**How the requested scope is actually built.** In `OpenidSsoFilter.java` the requested OAuth scope is:

```
requestedScope = getDefaultScope()  +  " "  +  <openIdScope web.xml init-param>
```

- `TrimbleIdentitySsoFilter.getDefaultScope()` returns `"openid iam"`.
- The **`openIdScope` init-param** (from `web.xml`, sourced from `${aa.tidScope}`) is appended. On `ams-ok-yp2` this is deployed as `OPS_prompt-patrol-env-2`.

So the default deployed request was `openid iam OPS_prompt-patrol-env-2` — **no `agents`** — and the granted token came back as `scope: "OPS_prompt-patrol-env-2 iam"`.

**Two things are required to actually get `agents` in the token:**

1. **Request it.** Add `agents` to the requested scope. The simplest change (no Java rebuild) is to append it to the `openIdScope` init-param for the `TrimbleIdentitySsoFilter` in `web.xml`:

   ```xml
   <!-- WEB-INF/web.xml — TrimbleIdentitySsoFilter -->
   <init-param>
       <param-name>openIdScope</param-name>
       <param-value>OPS_prompt-patrol-env-2 agents</param-value>
   </init-param>
   ```

   Alternatively, change `getDefaultScope()` to `"openid iam agents"` (requires a Java rebuild/redeploy).

2. **The OAuth client must be entitled to `agents`.** The authorization server silently drops any scope the client isn't registered for. The TID client `f69f789f-d964-430b-8bfe-2ba03251fd3d` (yp2) must be authorized for the `agents` scope in Trimble Identity / Agent Studio. If requesting `agents` doesn't make it appear in the decoded token, this registration is the blocker — it's a **Trimble identity/AI-team** action, not an AgileAssets code change.

**Verify the granted scope** by decoding the token in the browser console:

```js
(() => {
  const t = window.GVars && window.GVars.access_token;
  const p = JSON.parse(atob(String(t).split(".")[1].replace(/-/g,'+').replace(/_/g,'/')));
  return { scope: p.scope, aud: p.aud, iss: p.iss, exp: new Date(p.exp*1000).toISOString() };
})()
```

You must re-login via TID SSO after changing the scope — an existing session keeps the old token.

> **Persistence caveat:** editing `web.xml` directly inside a running pod is **ephemeral** and reverts on pod restart/redeploy. For a durable fix, set `agents` in the source of `${aa.tidScope}` — `ams-web/pom.xml` (`<aa.tidScope>`) and/or the environment's Helm/configmap values.

---

## 6. Part D: Iframe Embedding in AgileAssets

### Overview

The Trimble AI Assist chat is embedded as a floating panel in the AgileAssets web application, injected into `w_main.jsp` (the main shell page). It follows the same pattern as WalkMe integration.

### Files Created

**`ams-web/src/main/webapp/Kernel/trimble-assist.js`**

Self-contained JavaScript module that:
- Creates a floating blue FAB button (bottom-right corner)
- Opens a panel with the Trimble Assist iframe when clicked
- Registers 12 local tools as AgileAssets REST API operations
- Gets the TID token from `window.GVars.access_token`
- Passes user context (userId, adminUnit, module) to the AI agent
- Supports official Trimble iframe SDK (when installed) or direct iframe fallback

Local tools registered:

| Tool | API Endpoint | Method |
|------|-------------|--------|
| `list_work_requests` | `/rest/v2/workrequests` | GET |
| `get_work_request` | `/rest/v2/workrequests/{id}` | GET |
| `create_work_request` | `/rest/v2/workrequests` | POST |
| `list_work_orders` | `/rest/v2/workorders` | GET |
| `get_work_order` | `/rest/v2/workorders/{id}` | GET |
| `create_work_order` | `/rest/v2/workorders` | POST |
| `update_work_order` | `/rest/v2/workorders/{id}` | PUT |
| `list_assets` | `/rest/v2/assets` | GET |
| `list_asset_types` | `/rest/v2/assetType` | GET |
| `list_activities` | `/rest/v2/activity` | GET |
| `list_admin_units` | `/rest/v2/adminunit` | GET |
| `list_crews` | `/rest/v2/crew` | GET |
| `agile_assets_api` | `/rest/v2/{any}` | GET/POST/PUT/DELETE |

**Oracle DB tools (via MCP bridge):** `run_sql`, `run_dml`, `list_tables`, `describe_table`, `search_tables`, `table_sample`, `health_check`.

**DOM-interaction tools (read/act on the live AgileAssets UI in the `wrk_frame`/DataWindows):**

| Tool | Purpose |
|------|---------|
| `dom_get_page_context` | Which window is loaded, available DataWindows/grids, current user/admin unit. Use first. |
| `dom_read_grid` | Read rows/columns from a DataWindow (e.g. `dw_wo`, `dw_loc`, `dw_labor`). |
| `dom_get_grid_columns` | Column definitions (name, label, type) for a DataWindow. |
| `dom_get_current_row` | Data from the currently selected row. |
| `dom_get_menu_items` | Available Actions-menu items for a DataWindow. |
| `dom_click_action` | Execute a menu action (`insert`, `delete`, `make_daycards`, …). |
| `dom_set_field` | Set a cell value (row + column) in a grid. |
| `dom_select_row` | Select/highlight a row. |
| `dom_save` | Save the current window (`basic_window.SaveData()`). |
| `dom_navigate` | Click through the main menu to a window. |
| `dom_insert_row` | Insert a row (triggers WO Attributes dialog in Day Cards). |
| `dom_get_dropdown_values` | Valid dropdown values for a grid column. |
| `dom_interact_dialog` | Read/select/fill/click inside an open modal dialog. |
| `create_work_order_daycard` | Higher-level helper for the Day Cards WO creation flow. |

> **Tool delivery vs. tool usage.** Delivering these tools to the agent (via `onBeforeRun`) is the AgileAssets side and is working. Whether the agent actually *calls* them depends on the **agent's configuration in Trimble Agent Studio** (system prompt + client/local tools enabled). The knowledge-base "Work Assist" agent answers from uploaded PDFs and will not invoke DOM tools unless its instructions tell it to. Use/point to a tool-using agent for live UI interaction.

**`ams-web/src/main/webapp/Kernel/trimble-assist.css`**

Styles for the floating chat panel, FAB button, header, status bar.

**`ams-web/src/main/webapp/Kernel/w_main.jsp` (modified)**

Added after `w_gvars.jsp` include and `wgxpath.install()`. **`trimble-sdk.js` must load before `trimble-assist.js`** so `window.TrimbleAgenticSDK` exists when the assist script runs (both use `defer`, which preserves order):

```jsp
<%-- Trimble Agentic AI Assist – floating chat panel --%>
<%-- trimble-sdk.js exposes window.TrimbleAgenticSDK (official iframe SDK bundle) --%>
<link rel="stylesheet" href="<%=fullServletContextPath%>/Kernel/trimble-assist.css"/>
<script type="text/javascript" src="<%=fullServletContextPath%>/Kernel/trimble-sdk.js" defer></script>
<script type="text/javascript" src="<%=fullServletContextPath%>/Kernel/trimble-assist.js" defer></script>
```

**`ams-web/src/main/webapp/Kernel/trimble-sdk.js` (new — built artifact)**

The official Trimble iframe SDK, bundled into a self-contained browser IIFE that exposes `window.TrimbleAgenticSDK`. ~343 KB minified. Built from `trimble-sdk-src/` (see [Trimble Iframe SDK](#trimble-iframe-sdk--building-the-browser-bundle) below). This file is committed/deployed as a static asset; AgileAssets does **not** bundle the SDK through its own webpack/Vue build.

### How Tokens Flow

```
TID SSO Login
    │
    ▼
OpenidSsoFilter / TrimbleIdentitySsoFilter
    │  exchanges auth code for TID access_token
    │  stores in ServerSession.setAccessToken(token)
    ▼
w_gvars.jsp
    │  exposes as: GVars.access_token = "<%= gvarsServerSession.getAccessToken() %>"
    ▼
trimble-assist.js
    │  provideToken() → returns GVars.access_token
    │  getAuthHeaders() → "Authorization: Bearer " + GVars.access_token
    ▼
┌────────────────┐     ┌──────────────────────┐
│ Trimble iframe │     │ AgileAssets REST API  │
│ (TID auth)     │     │ (Bearer token auth)  │
└────────────────┘     └──────────────────────┘
```

### Frameable domains (fixing the blank iframe / `X-Frame-Options: DENY`)

A raw iframe to **`https://assist.stage.trimble-ai.com`** returns `X-Frame-Options: DENY` and renders blank — that's the standalone app domain and it refuses to be framed. The official SDK instead loads the chat UI from dedicated, frameable **`embed.*`** domains (exported by the SDK as `CHAT_UI_URLS`):

| Environment | Embed origin (frameable) |
|-------------|--------------------------|
| development | `https://embed.dev.trimble-ai.com` |
| stage | `https://embed.stage.trimble-ai.com` |
| prod | `https://embed.ai.trimble.com` |

`trimble-assist.js` uses `SDK.CHAT_UI_URLS[ENV]` for both the iframe `src` and the `postMessage` `targetOrigin`, and sets the iframe `sandbox` attribute from `SDK.CHAT_UI_IFRAME_SANDBOX_ATTRIBUTES` (`allow-same-origin allow-scripts allow-popups allow-downloads allow-forms`).

### Trimble Iframe SDK — building the browser bundle

The official SDK is ESM/TypeScript and can't be consumed directly by AgileAssets' AngularJS 1.8 + Vue 2 stack. We bundle it once into a self-contained IIFE (`window.TrimbleAgenticSDK`) with esbuild.

- Package: `@trimble-agentic-external-npm-local/agentic-platform-sdk-iframe-typescript` (**v1.3.0**)
- Registry: `artifactory.trimble.tools/artifactory/api/npm/trimble-agentic-external-npm-local/` (requires auth)

**Build directory:** `ams-web/src/main/webapp/Kernel/trimble-sdk-src/`

`package.json`:

```json
{
  "name": "trimble-assist-sdk-bundle",
  "private": true,
  "scripts": {
    "build": "esbuild sdk-entry.js --bundle --format=iife --global-name=TrimbleAgenticSDK --minify --legal-comments=none --outfile=../trimble-sdk.js"
  },
  "dependencies": {
    "@trimble-agentic-external-npm-local/agentic-platform-sdk-iframe-typescript": "1.3.0"
  },
  "devDependencies": { "esbuild": "^0.25.0" }
}
```

`sdk-entry.js`:

```js
export * from "@trimble-agentic-external-npm-local/agentic-platform-sdk-iframe-typescript";
```

`.npmrc` (project root — needed to install from Trimble Artifactory; **do not commit**, it's in `.gitignore`):

```
@trimble-agentic-external-npm-local:registry=https://artifactory.trimble.tools/artifactory/api/npm/trimble-agentic-external-npm-local/
always-auth=true
//artifactory.trimble.tools/artifactory/api/npm/trimble-agentic-external-npm-local/:_authToken=<TRIMBLE_ARTIFACTORY_TOKEN>
```

Build steps:

```bash
cd ams-web/src/main/webapp/Kernel/trimble-sdk-src
npm install --userconfig ../../../../../../.npmrc
npm run build          # → writes ../trimble-sdk.js (window.TrimbleAgenticSDK)
```

### How `trimble-assist.js` drives the SDK

When `window.TrimbleAgenticSDK` is present, `trimble-assist.js` wires the chat UI with `listenToChatUi`:

```
listenToChatUi(iframe, targetOrigin,
  provideChatUiConfig,   // buildChatConfig() → { environment, agentId, uiConfig, localization }
  provideChatUiToken,    // provideToken() → GVars.access_token (TID)
  onBeforeRun,           // provider function → { tools, runContext }
  onUnauthorized)        // handleUnauthorized() → re-provide token or undefined
```

Two critical details discovered on yp2:

1. **`onBeforeRun` is passed as a provider function** `(agentId) => Promise.resolve(buildOnBeforeRunConfig())`, not a static object. The child calls `callOnBeforeRun` with a **30 000 ms** default timeout; if the parent doesn't reply, it proceeds with **empty tools/context** (agent answers from knowledge base only, after a ~30s stall).

2. **Tool definitions must satisfy the SDK's Zod schema.** `ToolSchema.parameters`, when present, requires `type`, `properties`, **and `required` (array)**. A single tool missing `required` makes the child reject the **entire** `onBeforeRun` response → 30s timeout → no tools/context. `trimble-assist.js` includes `ensureToolSchemas(LOCAL_TOOLS)` which guarantees every tool's `parameters` has `type`/`properties`/`required` before the config crosses the iframe boundary:

   ```js
   function ensureToolSchemas(tools) {
       Object.keys(tools).forEach(function (id) {
           var p = tools[id] && tools[id].definition && tools[id].definition.parameters;
           if (!p) return;
           if (typeof p.type !== "string") p.type = "object";
           if (!p.properties || typeof p.properties !== "object") p.properties = {};
           if (!Array.isArray(p.required)) p.required = [];
       });
   }
   ```

If the SDK bundle is missing, `trimble-assist.js` falls back to a direct iframe embed against the `embed.*` domain with a `postMessage` bridge (note: in this mode the `?agentId=` param may be ignored and local tools won't bridge — load `trimble-sdk.js` for full functionality).

---

## 7. Part E: Kubernetes Deployment

### Environment

| Item | Value |
|------|-------|
| EKS Cluster | `aa-dev-eks` |
| AWS Region | `us-east-2` |
| Namespace | `ams-ok-yp2` (current) / `ams-ok-pp` (original) |
| Pod | `ams-ok-yp2-ams-web-assetmgm-*` |
| Webapp Path | `/usr/local/tomcat/webapps/ams-web` |

### Authentication

```bash
# 1. Authenticate to AWS via OKTA (interactive — run in terminal)
aws_okta_keyman -o trimble -u ypamula@am.trimblecorp.net --reup

# 2. Configure kubectl (one-time)
aws eks update-kubeconfig --name aa-dev-eks --region us-east-2
```

### Deploy Static Files

Since the changes are CSS, JS, and JSP (no Java recompile needed), files can be pushed directly to the running pod. **Include `trimble-sdk.js`** (the built SDK bundle):

```bash
NS="ams-ok-yp2"
POD=$(kubectl get pods -n $NS -o name | grep ams-web-assetmgm | head -1 | sed 's|pod/||')
WEBAPP="/usr/local/tomcat/webapps/ams-web"

echo "Deploying to: $POD"

# Copy files
kubectl cp ams-web/src/main/webapp/Kernel/trimble-sdk.js     "$NS/$POD:$WEBAPP/Kernel/trimble-sdk.js"
kubectl cp ams-web/src/main/webapp/Kernel/trimble-assist.js  "$NS/$POD:$WEBAPP/Kernel/trimble-assist.js"
kubectl cp ams-web/src/main/webapp/Kernel/trimble-assist.css "$NS/$POD:$WEBAPP/Kernel/trimble-assist.css"
kubectl cp ams-web/src/main/webapp/Kernel/w_main.jsp         "$NS/$POD:$WEBAPP/Kernel/w_main.jsp"

# Trigger Tomcat reload
kubectl exec -n "$NS" "$POD" -- touch "$WEBAPP/WEB-INF/web.xml"

# Verify
kubectl exec -n "$NS" "$POD" -- ls -la "$WEBAPP/Kernel/trimble-sdk.js" "$WEBAPP/Kernel/trimble-assist.js" "$WEBAPP/Kernel/trimble-assist.css"
```

### Add the `agents` scope (currently required for the agent to load)

Until `${aa.tidScope}` is updated at the source (pom/Helm/configmap), the scope can be patched directly in the running pod's `web.xml`. **This is ephemeral and reverts on pod restart/redeploy.**

```bash
NS="ams-ok-yp2"
POD=$(kubectl get pods -n $NS -o name | grep ams-web-assetmgm | head -1 | sed 's|pod/||')
WEBXML="/usr/local/tomcat/webapps/ams-web/WEB-INF/web.xml"

kubectl exec -n "$NS" "$POD" -- sh -c "
  cp $WEBXML ${WEBXML}.bak-agents;
  sed -i 's|<param-value>OPS_prompt-patrol-env-2</param-value>|<param-value>OPS_prompt-patrol-env-2 agents</param-value>|' $WEBXML;
  touch $WEBXML   # triggers Tomcat context reload
"
```

After this, **log out and log back in via TID SSO** so a fresh token is issued with the `agents` scope, then verify with the console decode snippet in [Part C](#tid-scopes-important--this-is-what-makes-failed-to-load-agent-go-away).

### Verify Deployment

```bash
# Tail logs to confirm reload
kubectl exec -it -n "$NS" "$POD" -- tail -f /usr/local/tomcat/logs/ams-web/ams-web.log
```

After reload completes (~30 seconds), log in to the application. The blue chat FAB button should appear in the bottom-right corner.

---

## 8. Part F: Connecting Additional Data Sources

### Current MCP Servers in Cursor

| Server | Purpose |
|--------|---------|
| `agile-assets-api` | AgileAssets REST API (41 tools) |
| `oracle-sqlcl` | Direct Oracle DB queries via SQLcl |
| `jira-trimble` | Jira (Trimble) ticket access |
| `jira-agileassets` | Jira (AgileAssets) ticket access |
| `confluence-trimble` | Confluence (Trimble) documentation |
| `confluence-agileassets` | Confluence (AgileAssets) documentation |
| `n8n-trimble-stage` | n8n workflow automation |

### Connecting Data Sources to Trimble Agent Studio

To add tools in Agent Studio, go to Configure Agent → Tools → Create a Tool → MCP tab:

| Field | Description |
|-------|-------------|
| Name | Display name for the tool |
| URL | HTTP endpoint for the MCP server (must be network-accessible) |
| Authentication | `None`, `On behalf of actor token`, or `Agent token` |
| Scopes | Required TID scopes |

**To connect the Oracle database or other sources to the Trimble platform:**

1. Deploy the MCP server as an HTTP/SSE service (not stdio) on a network-accessible host
2. The MCP Python SDK supports HTTP transport: change `mcp.run(transport="stdio")` to `mcp.run(transport="sse", host="0.0.0.0", port=8000)`
3. Register the URL in Trimble Agent Studio

### Knowledge Base

Upload AgileAssets documentation from https://docsagileassets.atlassian.net to the Agentic Knowledge Library in Trimble Agent Studio. This gives the agent access to:

- Getting Started guides
- Administration Guide
- Module-specific documentation (Maintenance Manager, Fleet, Pavement, etc.)
- Knowledge Base / FAQ
- Release Notes

---

## 9. File Reference

| File | Purpose |
|------|---------|
| `agile-assets-mcp/server.py` | Python MCP server for Cursor (41 API tools) |
| `agile-assets-mcp/requirements.txt` | Python dependencies (`mcp[cli]`, `httpx`) |
| `agile-assets-mcp/.venv/` | Python 3.13 virtual environment |
| `.cursor/mcp.json` | MCP server registrations for Cursor |
| `ams-web/src/main/webapp/Kernel/trimble-assist.js` | Trimble AI Assist iframe integration (SDK wiring, local + DOM tools, `ensureToolSchemas`) |
| `ams-web/src/main/webapp/Kernel/trimble-assist.css` | Chat panel styles |
| `ams-web/src/main/webapp/Kernel/trimble-sdk.js` | Built IIFE bundle of the official iframe SDK (`window.TrimbleAgenticSDK`) |
| `ams-web/src/main/webapp/Kernel/trimble-sdk-src/` | esbuild build dir for `trimble-sdk.js` (`package.json`, `sdk-entry.js`); `node_modules/` gitignored |
| `ams-web/src/main/webapp/Kernel/w_main.jsp` | Modified to load `trimble-sdk.js` then `trimble-assist.js` |
| `ams-web/src/main/webapp/WEB-INF/web.xml` | `TrimbleIdentitySsoFilter` `openIdScope` init-param (add `agents`) |
| `ams-web/pom.xml` | `${aa.tidScope}` source for the `openIdScope` init-param |
| `.npmrc` (project root) | Trimble Artifactory auth for installing the SDK (gitignored) |
| `ams-web/src/main/resources/swagger/security_description.md` | API auth documentation |
| `ams-web/src/main/java/com/agileassetsinc/service/oauth2/Oauth2Constants.java` | Token expiry constants |
| `ams-web/src/main/java/com/agileassetsinc/core/TrimbleIdentitySsoFilter.java` | TID SSO filter (scope config) |
| `ams-web/src/main/webapp/Kernel/w_gvars.jsp` | Exposes GVars (access_token, aa_sid) to JS |

---

## 10. Troubleshooting

### Chat button doesn't appear

- **Check auth type**: The button was initially gated on `SSO_TID` auth type. Current version loads for all users. Verify the JSP was deployed: `kubectl exec -n $NS $POD -- grep "trimble-assist" $WEBAPP/Kernel/w_main.jsp`
- **Check browser console**: Open DevTools (F12) and look for `[TrimbleAssist]` log messages
- **Hard refresh**: Cmd+Shift+R to bypass cached JSP

### Iframe is blank / `Refused to display ... X-Frame-Options: DENY`

- You're pointing the iframe at `assist.stage.trimble-ai.com` (standalone app, refuses framing). Use the frameable **`embed.*`** domains via `SDK.CHAT_UI_URLS[ENV]` (e.g. `embed.stage.trimble-ai.com`). See [Part D](#frameable-domains-fixing-the-blank-iframe--x-frame-options-deny).

### "Failed to load agent" (chat loads, agents list, but the agent won't open)

- The TID token is missing the **`agents`** scope. Decode `GVars.access_token` (snippet in [Part C](#tid-scopes-important--this-is-what-makes-failed-to-load-agent-go-away)).
- If scope shows e.g. `OPS_prompt-patrol-env-2 iam` (no `agents`): add `agents` to the `openIdScope` init-param (Part C / Part E) and **re-login via TID SSO**.
- If you added `agents` but it still doesn't appear in the decoded token: the OAuth client isn't entitled to `agents` — escalate to the Trimble identity/AI team to register the scope for client `f69f789f-...`.
- **"Connected as YASH"** refers to the AgileAssets user ID, not the TID identity — it does not indicate the TID token is valid.

### Answers take ~30 seconds and/or the agent ignores tools/context

- The SDK's `callOnBeforeRun` timed out (30 000 ms) because the parent's `onBeforeRun` response was rejected/never delivered. Look for `[aui-p-iframe-sdk] OnBeforeRun ... timed out ... 30000ms` in the console.
- Cause seen on yp2: a tool definition with `parameters` but **no `required` array** fails the child's Zod validation and invalidates the whole response. Ensure `ensureToolSchemas(LOCAL_TOOLS)` runs in `buildOnBeforeRunConfig()`, and that `onBeforeRun` is passed as a **provider function** (see [Part D](#how-trimble-assistjs-drives-the-sdk)).

### Agent responds but won't "read my screen" / use DOM tools

- Expected for the knowledge-base "Work Assist" agent — it answers from uploaded PDFs. Tool *delivery* works; tool *usage* is controlled by the agent's system prompt + enabled tools in Trimble Agent Studio. Use/configure a tool-using agent for live UI interaction.

### `models-api.stage.trimble-ai.com/v3/users/me/usage` 401 / CORS spam

- Non-blocking: this is the usage/quota widget. The chat still works. Safe to ignore unless you specifically need the usage indicator.

### Changes don't take effect after `kubectl cp`

- JS/CSS: hard-refresh the browser (Cmd+Shift+R). JSP/`web.xml`: `touch $WEBAPP/WEB-INF/web.xml` to trigger a Tomcat context reload (~30s).
- Remember pod edits are **ephemeral** — a pod restart/redeploy reverts `web.xml` and any files not baked into the image.

### Token issues

- **Token expired**: The MCP server auto-refreshes. For Postman, re-run the login call.
- **401 Unauthorized**: Verify credentials. Check if the user has API access in System → Security → User Level → API Security Settings.
- **TID token missing `agents` scope**: The requested scope is `getDefaultScope()` + the `openIdScope` **web.xml init-param** — add `agents` to the init-param (or to `getDefaultScope()`), re-login via TID SSO, and confirm the OAuth client is entitled to `agents`. Full details in [Part C](#tid-scopes-important--this-is-what-makes-failed-to-load-agent-go-away).

### Kubernetes connectivity

- **kubectl refused**: Run `aws_okta_keyman` to refresh AWS credentials
- **No kubeconfig**: Run `aws eks update-kubeconfig --name aa-dev-eks --region us-east-2`
- **Pod not found**: List pods with `kubectl get pods -n ams-ok-pp`

### API returns no data

- **Check permissions**: The user's security role must have API groups assigned (System → Security → User Level → API Security Settings)
- **Check filters**: API endpoints support `limit`, `offset`, and field-level filters as query params
- **Check Swagger**: Browse available endpoints at `/ams-web/swagger/index.html`
