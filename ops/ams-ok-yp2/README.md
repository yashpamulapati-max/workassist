# ams-ok-yp2 ops

> **Runnable copy — keep this repo private.** The `web.xml` here is the real, resolved config
> (including `@aaEncrypted@…` AgileAssets-encrypted values, not plaintext secrets) and can be pushed
> to the pod as-is for recovery. It is kept here so partners can run the recovery directly.

Config for recovering the AgileAssets `ams-web` app on the `ams-ok-yp2` environment.

## `web.xml`

The resolved, patched `WEB-INF/web.xml` for the running pod. It differs from the repo template
(`ams-web/src/main/webapp/WEB-INF/web.xml`, which only has the `${aa.tidScope}` placeholder) in that:

- All TID init-params are resolved to real values for `ams-ok-yp2` (stage).
- The active `TrimbleIdentitySsoFilter` `openIdScope` includes the **`agents`** scope:
  `OPS_prompt-patrol-env-2 agents` — required for the embedded Work Assist agent to authorize
  against the Agent Service.

This is an **ephemeral** override: it is pushed into the running container's filesystem and is
**lost whenever the pod is recreated** (deploy, node recycle, `kubectl delete pod`). This copy exists
so it can be re-pushed quickly.

## When to use

App down / SSO failing / "Failed to load agent" on `ams-ok-yp2`. Follow the
`ams-ok-sso-pod-restart` skill (`.cursor/skills/ams-ok-sso-pod-restart/SKILL.md`), which pushes this
`web.xml` into the pod and reloads the `/ams-web` context.

Quick reference:

```bash
aws_okta_keyman -o trimble -u ypamula@am.trimblecorp.net --reup
kubectl get pods -n ams-ok-yp2
kubectl -n ams-ok-yp2 cp ~/agileassetsweb-project/ops/ams-ok-yp2/web.xml <POD>:/usr/local/tomcat/webapps/ams-web/WEB-INF/web.xml
kubectl logs -n ams-ok-yp2 <POD> | tail -n 20   # expect: Reloading Context with name [/ams-web] is completed
```

Also re-push Kernel embed files (`trimble-assist.js` / `.css` / `trimble-sdk.js` / `w_main.jsp`).
`w_main.jsp` uses `?v=` cache-bust — bump it with JS changes. Window navigation reloads `w_main.jsp`;
the panel restores from `sessionStorage` if it was open.

## Permanent fix (removes the need for this)

Bake `agents` into the Helm/configmap value behind `${aa.tidScope}` for `ams-ok-yp2` so the scope
survives pod recreation. Parked as a pre-AISummit (Aug 26) follow-up.

## Note on secrets

`web.xml` contains `@aaEncrypted@...` values (AgileAssets-encrypted, not plaintext secrets). Do not
replace these with decrypted values.
