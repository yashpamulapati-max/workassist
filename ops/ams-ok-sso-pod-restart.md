---
name: ams-ok-sso-pod-restart
description: Recover the AgileAssets ams-web app when it is down on the ams-ok-yp2 (or similar ams-ok-*) environment by restarting/reloading the SSO-enabled Tomcat pod and re-pushing the patched web.xml. Use when the app is down, returns a blank page, SSO/login fails, the Work Assist agent stops loading, or after a pod has been recreated and the agents scope / TID scope reverted.
---

# ams-ok SSO Pod Restart & Recovery

Recovery runbook for the AgileAssets `ams-web` app on the `ams-ok-yp2` environment (and other `ams-ok-*` namespaces that use the same pattern).

## When to use

- The app is down / blank / 5xx (e.g. `https://ams-ok-yp2-web.app.np.agileassets.net/ams-web/`).
- SSO login fails or `w_sso_user.jsp` errors.
- The embedded **Work Assist** agent stops loading with "Failed to load agent".
- A pod was recreated (deploy, node recycle, `kubectl delete pod`) and reverted the **hand-patched `web.xml`** (resolved `openIdScope` including the `agents` scope).

## CRITICAL context — why we re-push web.xml

The `agents` scope was added to `web.xml` **by hand inside the running pod** (an ephemeral edit). The repo template at `ams-web/src/main/webapp/WEB-INF/web.xml` only contains the unresolved placeholder `${aa.tidScope}` — it is **NOT** a valid push source.

- The **only valid push source** is your locally-saved, already-resolved `web.xml` (the one containing the real scope value, e.g. `OPS_prompt-patrol-env-2 agents`).
- Whenever Kubernetes recreates the pod, the container filesystem resets to the image and the edit is **lost** — that is why recovery re-`cp`s the saved `web.xml` back in.
- Permanent fix (removes the need for this runbook): bake `agents` into the Helm/configmap value behind `${aa.tidScope}` for `ams-ok-yp2`, then this manual push is no longer required.

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

## Do / Don't

- **DO** reload by `cp`/`touch` of `web.xml` — it preserves the running container and re-reads config.
- **DO** re-push the saved `web.xml` after any pod recreation.
- **DON'T** `kubectl delete pod` as a "fix" unless you immediately re-push `web.xml` afterward — a bare delete reverts the `agents` scope and the agent will fail to load again.
- **DON'T** push the repo template `web.xml` (`${aa.tidScope}` placeholder) — it is not resolved.

## Related

- `k8s-tomcat-restart` skill — general Tomcat pod management (find pod, touch web.xml, view logs, forceful delete).
- Setup reference: `media/trimble-ai-setup/TRIMBLE-AGENTIC-AI-SETUP.md` (TID scopes, agents scope, iframe embed).
