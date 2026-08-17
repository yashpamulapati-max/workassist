# Work Assist embed snapshot (`v=20260817a`)

Canonical copies of the Kernel files deployed to `ams-ok-yp2` via `kubectl cp`.
Live path on the pod: `/usr/local/tomcat/webapps/ams-web/Kernel/`.

| File | Role |
| --- | --- |
| `trimble-sdk.js` | Trimble Agentic iframe SDK (load first) |
| `trimble-assist.js` | FAB, panel, host tools, window catalog, finder, Diagnostics overlay |
| `trimble-assist.css` | Panel / finder / diagnostics overlay |
| `trimble-assist-ok-menus.json` | Oklahoma SYSTEM_MENU (563 windows) |
| `w_main.jsp` | Shell; cache-bust `?v=20260817a` |

Working copy in the AgileAssets tree: `ams-web/src/main/webapp/Kernel/` (not committed there — product `develop` is unrelated). After pod recreation, push these five files plus `ops/ams-ok-yp2/web.xml` (see `ops/ams-ok-sso-pod-restart.md`).
