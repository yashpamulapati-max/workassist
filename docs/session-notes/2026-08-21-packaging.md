# Work Assist — Session Notes (2026-08-21)

Live embed on `ams-ok-yp2` is unchanged: **`v=20260817d`**.

This session captured how to package WorkAssist Agent so another AgileAssets
application can add it — not a new embed snapshot.

Canonical pack: [`packaging/`](../../packaging/) ([README](../../packaging/README.md)).
Board: [workassist](https://github.com/users/yashpamulapati-max/projects/1).

---

## Packaging WorkAssist Agent for AgileAssets Application

Work Assist is two layers:

1. **Agent Studio (cloud)** — instructions, KB, evals, connectors. Survives pod recycle.
2. **AMS embed (WAR)** — FAB, finder, Diagnostics, host tools, SDK. Today ephemeral `kubectl cp`.

Do not copy yp2 `web.xml`, OK FAQ numbers, or `kubectl cp` as the product install.

**Three packages to ship**

- Embed in `ams-web` behind `aa.workassist.enabled`, Helm `aa.tidScope` += ` agents`
- Studio template agent (clone; do not hardcode `37242c15-…` for every tenant)
- Per-tenant `SYSTEM_MENU` catalog (not OK 563-row JSON)

**Another env, until the WAR bake:** TID SSO → append `agents` → merge Kernel tags into
that image’s `w_main.jsp` → set agentId/env → export that DB’s menus → verify console
`[WorkAssist] Loaded v=…`.
