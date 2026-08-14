# Work Assist embed snapshot (`v=20260814d`)

Canonical copies of the Kernel files deployed to `ams-ok-yp2` via `kubectl cp`.
Live path on the pod: `/usr/local/tomcat/webapps/ams-web/Kernel/`.

| File | Role |
| --- | --- |
| `trimble-sdk.js` | Trimble Agentic iframe SDK (load first) |
| `trimble-assist.js` | FAB, panel, host tools, window catalog, finder, Jira copy, log viewer |
| `trimble-assist.css` | Panel / finder / log overlay |
| `trimble-assist-ok-menus.json` | Oklahoma SYSTEM_MENU (563 windows) |
| `w_main.jsp` | Shell; cache-bust `?v=20260814d` |

Working copy in the AgileAssets tree: `ams-web/src/main/webapp/Kernel/` (not committed there — product `develop` is unrelated). After pod recreation, push these five files plus `ops/ams-ok-yp2/web.xml` (see `ops/ams-ok-sso-pod-restart.md`).
