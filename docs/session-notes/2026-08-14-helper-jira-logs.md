# Work Assist — Session Notes (2026-08-14 evening)

Live embed on `ams-ok-yp2`. Cache-bust: **`?v=20260814d`**.
Console: `[WorkAssist] Loaded v=20260814d` and `window catalog=563`.

Embed snapshot in this repo: [`embed/Kernel/`](../../embed/Kernel/).

---

## Helper absorb (Phase 1 + typeahead)

Internal **AgileAssets Navigation Helper** v1.2 catalog is now in Work Assist.

- `search_windows` / `open_window` use `w_main.jsp?AA_SID=&menu_id=` (not menu clicks).
- Roadway Day Cards = `3_wo_daycards`.
- Parent **Open a window…** finder (Helper-style). Chat iframe cannot typeahead (cross-origin).
- **⌘/Ctrl+K** focuses the finder. Enter opens; ⌘/Ctrl+Enter new session.

## Phase 2

- Location chip: `Day Cards · 3_wo_daycards`.
- Host tool: `get_window_identity`.

## Keiichi Yamamoto (Helper comment, Oct 2025)

| Ask | In Work Assist |
| --- | --- |
| Menu search (hackathons 2017/2021 never shipped in product) | Finder + catalog tools |
| Copy build + breadcrumb for Jira | Header clipboard icon |
| View live logs without downloading from Logs | Header log icon → last ~250 KB of `ams-web.log` in the panel |

Clipboard payload: URL, breadcrumb + `menu_id`, user/admin unit/env, `build.html` version/branch/commit/build #/date.

Logs: AMS has no HTTP tail API. Work Assist calls System Logs `download_file` then `get_file` and renders text in the panel (no `file://` download). If not already on **System > Tools > Logs**, it opens `system_log` once then loads.

## Not absorbed (stay in Helper)

Form Layout Editor, log styler chrome, JVM/DB gauges, Chrome host permissions.

## Deploy

Pod `ams-ok-yp2-ams-web-assetmgm-7b75596b55-mzv6q`. Files: `trimble-assist.js/css`, `trimble-assist-ok-menus.json`, `w_main.jsp`. `touch web.xml`. Reload completed.

## Open follow-ups

- [ ] Live `SYSTEM_MENU` query instead of packaged CSV
- [ ] Permanent `agents` + Kernel files in the image (week before AISummit 3.0)
- [ ] Quiet `models-api …/usage` 401/CORS
- [ ] Setup-guide PDF/HTML
