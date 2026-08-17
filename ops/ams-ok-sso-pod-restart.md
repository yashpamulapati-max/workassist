---
name: ams-ok-sso-pod-restart
description: Recover the AgileAssets ams-web app when it is down on the ams-ok-yp2 (or similar ams-ok-*) environment by restarting/reloading the SSO-enabled Tomcat pod, re-pushing the patched web.xml, and re-pushing the ephemeral Work Assist embed files (trimble-assist.js/css, trimble-sdk.js, w_main.jsp). Use when the app is down, returns a blank page, SSO/login fails, the Work Assist agent stops loading, the Work Assist chat FAB/panel is missing, or after a pod has been recreated and the agents scope / TID scope / embed files reverted.
---

# ams-ok SSO Pod Restart & Recovery

Recovery runbook for the AgileAssets `ams-web` app on the `ams-ok-yp2` environment (and other `ams-ok-*` namespaces that use the same pattern).

## When to use

- The app is down / blank / 5xx (e.g. `https://ams-ok-yp2-web.app.np.agileassets.net/ams-web/`).
- SSO login fails or `w_sso_user.jsp` errors.
- The embedded **Work Assist** agent stops loading with "Failed to load agent".
- The Work Assist **chat FAB / panel is missing** (bottom-right button gone) — the embed files reverted.
- A pod was recreated (deploy, node recycle, `kubectl delete pod`) and reverted the **hand-patched `web.xml`** (resolved `openIdScope` including the `agents` scope) and/or the **embed files**.

## CRITICAL context — why we re-push web.xml

The `agents` scope was added to `web.xml` **by hand inside the running pod** (an ephemeral edit). The repo template at `ams-web/src/main/webapp/WEB-INF/web.xml` only contains the unresolved placeholder `${aa.tidScope}` — it is **NOT** a valid push source.

- The **only valid push source** is your locally-saved, already-resolved `web.xml` (the one containing the real scope value, e.g. `OPS_prompt-patrol-env-2 agents`).
- Whenever Kubernetes recreates the pod, the container filesystem resets to the image and the edit is **lost** — that is why recovery re-`cp`s the saved `web.xml` back in.
- Permanent fix (removes the need for this runbook): bake `agents` into the Helm/configmap value behind `${aa.tidScope}` for `ams-ok-yp2`, then this manual push is no longer required.

## CRITICAL context — the Work Assist embed files are ALSO ephemeral

The floating chat FAB/panel is injected by `Kernel/w_main.jsp` and depends on three static files, all
deployed by hand via `kubectl cp` (never in the image). On pod recreation they vanish and the FAB
disappears — the same failure mode as the `web.xml` scope. You must re-push them too.

Push source = the repo working copy under
`ams-web/src/main/webapp/Kernel/`:

| File | Purpose |
| ---- | ------- |
| `trimble-sdk.js` | Bundled Trimble Agentic iframe SDK (`window.TrimbleAgenticSDK`) — must load first |
| `trimble-assist.js` | Embed logic: iframe, local tools, onBeforeRun/token via SDK |
| `trimble-assist.css` | FAB + panel styles |
| `trimble-assist-ok-menus.json` | Oklahoma SYSTEM_MENU catalog (search_windows / open_window) |
| `w_main.jsp` | Shell page that injects the CSS + both scripts (defer, order preserved) |

Permanent fix: bundle these into the ams-web build/image so they survive recreation.

## Prerequisites

- `kubectl` configured for the `aa-dev-eks` cluster (context: `arn:aws:eks:us-east-2:679788151510:cluster/aa-dev-eks`).
- Your saved, resolved `web.xml` on disk (see step 2 — the "folder named XX on the Desktop").
- Okta MFA available on your device (the auth step is interactive).

## Recovery Steps

### 1. Authenticate with Okta Keyman (interactive — run in your own terminal)

```bash
aws_okta_keyman -o trimble -u ypamula@am.trimblecorp.net --reup
```

Complete the MFA push/prompt. Verify with:

```bash
kubectl get pods -n ams-ok-yp2
```

If you see `You must be logged in to the server`, the auth did not take — re-run the command above.

### 2. Navigate to the canonical patched web.xml

The version-controlled, resolved-and-patched copy lives in the repo:

```bash
cd ~/agileassetsweb-project/ops/ams-ok-yp2
```

Sanity-check it is the patched file (should print the `agents` value line):

```bash
grep -n "OPS_prompt-patrol-env-2 agents" web.xml
```

> This repo copy is the source of truth. If you ever pull a fresh `web.xml` from the pod, re-apply the `agents` scope and update `ops/ams-ok-yp2/web.xml` so it stays canonical.

### 3. Find the new pod name

Look for `ams-ok-yp2-ams-web-assetmgm-...`:

```bash
kubectl get pods -n ams-ok-yp2
```

### 4. Push web.xml to the pod

Replace `<NEW-POD-NAME>` with the name from step 3 (run from `ops/ams-ok-yp2`, or use the full path):

```bash
kubectl -n ams-ok-yp2 cp web.xml <NEW-POD-NAME>:/usr/local/tomcat/webapps/ams-web/WEB-INF/web.xml
# or from anywhere:
# kubectl -n ams-ok-yp2 cp ~/agileassetsweb-project/ops/ams-ok-yp2/web.xml <NEW-POD-NAME>:/usr/local/tomcat/webapps/ams-web/WEB-INF/web.xml
```

Copying (or `touch`-ing) `web.xml` triggers Tomcat to auto-reload the `/ams-web` context and re-read the init-params — no container restart needed.

### 4b. Re-push the Work Assist embed files (if the chat FAB is missing)

If the chat FAB/panel is gone (or after any pod recreation), the embed files were lost too. Re-push all
four from the repo `Kernel` dir, then trigger one reload. Check first:

```bash
kubectl exec -n ams-ok-yp2 <NEW-POD-NAME> -- ls /usr/local/tomcat/webapps/ams-web/Kernel/trimble-assist.js
# "No such file" ⇒ re-push:
cd ~/agileassetsweb-project/ams-web/src/main/webapp/Kernel
K=/usr/local/tomcat/webapps/ams-web/Kernel
kubectl -n ams-ok-yp2 cp trimble-sdk.js     <NEW-POD-NAME>:$K/trimble-sdk.js
kubectl -n ams-ok-yp2 cp trimble-assist.js  <NEW-POD-NAME>:$K/trimble-assist.js
kubectl -n ams-ok-yp2 cp trimble-assist.css <NEW-POD-NAME>:$K/trimble-assist.css
kubectl -n ams-ok-yp2 cp trimble-assist-ok-menus.json <NEW-POD-NAME>:$K/trimble-assist-ok-menus.json
kubectl -n ams-ok-yp2 cp w_main.jsp         <NEW-POD-NAME>:$K/w_main.jsp
# reload once so the new w_main.jsp recompiles:
kubectl exec -n ams-ok-yp2 <NEW-POD-NAME> -- touch /usr/local/tomcat/webapps/ams-web/WEB-INF/web.xml
```

`w_main.jsp` loads Kernel JS/CSS with a cache-bust query (`?v=20260817d`). After changing
`trimble-assist.js` / `.css`, bump that version in `w_main.jsp` (and `ASSET_VER` in the JS) **and**
re-push the JSP **and** `trimble-assist-ok-menus.json`, then `touch web.xml` so Tomcat recompiles it. Confirm in the browser console:
`[WorkAssist] Loaded v=…`. A hard refresh alone is not enough if the JSP still points at the old `?v=`.

Window changes (`OnChangeCurrentWindow`) reload `w_main.jsp`. The embed persists open/expanded/thread
in `sessionStorage` (`ta-panel-open`, `ta-panel-expanded`, `ta-thread-id`).

### 5. Verify the reload

Check the last 20 lines for `Reloading Context with name [/ams-web] is completed`:

```bash
kubectl logs -n ams-ok-yp2 <NEW-POD-NAME> | tail -n 20
```

(Alternatively tail the app log: `kubectl exec -n ams-ok-yp2 <NEW-POD-NAME> -- tail -n 40 /usr/local/tomcat/logs/ams-web/ams-web.log`.)

### 6. Hard refresh and log in

- Hard refresh the browser (Cmd+Shift+R) at `https://ams-ok-yp2-web.app.np.agileassets.net/ams-web/`.
- Log in via TID SSO so a **fresh token** is minted with the `agents` scope.
- Confirm the Work Assist panel loads the agent (no "Failed to load agent").

## New environment (yp2 taken down, new `ams-ok-*` URL)

Same enhancements, new namespace. Do **not** blindly copy `ops/ams-ok-yp2/web.xml` if JDBC / TID client ids changed.

### What carries over unchanged (do not rebuild)

- Studio agent `37242c15-9716-4b91-9032-e8f7390d1d80` (stage). Instructions, Description, KB, evals stay in Studio.
- Iframe host: `https://embed.stage.trimble-ai.com` (never `assist.stage` — `X-Frame-Options: DENY`).
- Embed snapshot: GitHub [`embed/Kernel/`](https://github.com/yashpamulapati-max/workassist/tree/develop/embed/Kernel) or local `ams-web/src/main/webapp/Kernel/` (`v=20260817d`).
- OK window catalog JSON (same OK menus unless the new DB is a different client).

### What you must redo on the new env

1. **Okta + kube**
   ```bash
   aws_okta_keyman -o trimble -u ypamula@am.trimblecorp.net --reup
   aws eks update-kubeconfig --name aa-dev-eks --region us-east-2
   kubectl get pods -n <NEW-NS>   # e.g. ams-ok-yp3
   ```
2. **Login URL must be TID SSO**, not classic `w_login.jsp`:
   `https://<NEW-HOST>/ams-web/Kernel/w_sso_user.jsp`
   Confirm the app comes up and `GVars.access_token` is a TID token.
3. **Patch `agents` on the NEW pod’s `web.xml`** (do not set `OPENID_SCOPE` env — it duplicates the SSO filter).
   ```bash
   NS=<NEW-NS>
   kubectl -n $NS get pods | grep ams-web
   POD=<ams-web-pod-name>
   kubectl -n $NS cp $POD:/usr/local/tomcat/webapps/ams-web/WEB-INF/web.xml /tmp/new-web.xml
   ```
   In `/tmp/new-web.xml`, find the **active** `TrimbleIdentitySsoFilter` `openIdScope` and **append** ` agents` (keep the existing `OPS_…` value). Example: `OPS_prompt-patrol-env-2 agents`. Save a copy under `ops/<NEW-NS>/web.xml` so you can re-push after the next recycle.
   ```bash
   kubectl -n $NS cp /tmp/new-web.xml $POD:/usr/local/tomcat/webapps/ams-web/WEB-INF/web.xml
   ```
4. **Push the five embed files** (GitHub snapshot or local Kernel):
   ```bash
   SRC=~/workassist/embed/Kernel   # or ~/agileassetsweb-project/ams-web/src/main/webapp/Kernel
   K=/usr/local/tomcat/webapps/ams-web/Kernel
   kubectl -n $NS cp $SRC/trimble-sdk.js $POD:$K/trimble-sdk.js
   kubectl -n $NS cp $SRC/trimble-assist.js $POD:$K/trimble-assist.js
   kubectl -n $NS cp $SRC/trimble-assist.css $POD:$K/trimble-assist.css
   kubectl -n $NS cp $SRC/trimble-assist-ok-menus.json $POD:$K/trimble-assist-ok-menus.json
   kubectl -n $NS cp $SRC/w_main.jsp $POD:$K/w_main.jsp
   kubectl -n $NS exec $POD -- touch /usr/local/tomcat/webapps/ams-web/WEB-INF/web.xml
   kubectl -n $NS logs $POD | tail -n 20   # wait for: Reloading Context … is completed
   ```
   If the new image’s `w_main.jsp` differs from yp2’s, **merge** the Trimble CSS/SDK/JS tags into that JSP instead of overwriting blindly.
5. **Hard-refresh**, SSO again (new token must include `agents`), confirm console:
   `[WorkAssist] Loaded v=20260817d` and `window catalog=563`.
   FAB present. Agent loads (not “Failed to load agent”). Finder present. Header is logs / expand / close (copy lives inside Diagnostics).

### Optional (Cursor MCP / REST, not required for the embed)

If you still use `agile-assets-api` MCP, point `AA_BASE_URL` at the new `/ams-web` and the new Oracle DSN. The in-app embed talks same-origin REST with the user’s TID token — no ngrok.

## Do / Don't

- **DO** reload by `cp`/`touch` of `web.xml` — it preserves the running container and re-reads config.
- **DO** re-push the saved `web.xml` after any pod recreation.
- **DO** re-push the five embed files (step 4b / new-env step 4) after any pod recreation — the chat FAB depends on them and they are ephemeral just like the `web.xml` scope.
- **DO** merge Trimble script tags into the **new image’s** `w_main.jsp` if that JSP differs from yp2’s — do not blindly overwrite a newer shell.
- **DON'T** `kubectl delete pod` as a "fix" unless you immediately re-push `web.xml` afterward — a bare delete reverts the `agents` scope and the agent will fail to load again.
- **DON'T** push the repo template `web.xml` (`${aa.tidScope}` placeholder) — it is not resolved.

## Related

- `k8s-tomcat-restart` skill — general Tomcat pod management (find pod, touch web.xml, view logs, forceful delete).
- Setup reference: `media/trimble-ai-setup/TRIMBLE-AGENTIC-AI-SETUP.md` (TID scopes, agents scope, iframe embed).
