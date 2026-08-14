# Work Assist — Session Notes (2026-08-14 afternoon)

Absorbed the internal **AgileAssets Helper Extension** window catalog into the live
`ams-ok-yp2` embed so Work Assist can open AMS windows the same way the Helper does.

Cache-bust: **`?v=20260814b`**. Console: `[WorkAssist] Loaded v=20260814b` and
`[WorkAssist] window catalog=563`.

---

## What we absorbed (Phase 1)

Helper’s in-page search navigates with:

```
/Kernel/w_main.jsp?AA_SID=…&menu_id=3_wo_daycards
```

Work Assist used to **click menu link text** (`dom_navigate`). That is gone for
catalog matches. New host tools:

| Tool | Role |
| --- | --- |
| `search_windows` | Keyword → `menu_id`, label, path (Oklahoma SYSTEM_MENU) |
| `open_window` | `menu_id` (or a high-confidence `query`) → same-tab `menu_id` URL |
| `dom_navigate` | Now a catalog lookup wrapper (same URL), not menu clicks |

Catalog file: `Kernel/trimble-assist-ok-menus.json` (563 rows from Helper
`menus/OK_menus.csv`). Day Cards is **module-specific**:

- Roadway → `3_wo_daycards`
- Bridge → `4_wo_daycards`
- Facilities → `7_wo_daycards`
- Telecom → `8_wo_daycards`

Generic “day cards / work order window” prefers **Roadway**. Ambiguous matches
return a choice list instead of navigating.

Panel persist (`ta-panel-open` / `ta-thread-id`) still applies: `open_window`
reloads `w_main.jsp` and the chat stays open.

Host `onBeforeRun` tool count is **20** (previous 18 + these two). Context stays
≤ 10. New context line: use `search_windows` then `open_window`; do not click
the menu tree.

---

## Not absorbed (stay in Helper)

Form Layout Editor, ams-web.log styler, JVM/DB gauges, Chrome host permissions,
CSV maintenance UI.

---

## Studio instruction (paste)

Add to Work Assist **Instructions** (not Description):

> To open an AgileAssets window, call `search_windows` with the user’s name
> (e.g. “day cards”, “system logs”), then `open_window` with the returned
> `menu_id`. Do not click through the menu tree. Roadway Day Cards is
> `3_wo_daycards`. If several modules match, ask which path (Roadway /
> Facilities / Bridge / Telecom) or pass the exact `menu_id`.

---

## Deploy

Pod `ams-ok-yp2-ams-web-assetmgm-7b75596b55-mzv6q` (not recreated). Pushed
`trimble-assist.js`, `trimble-assist.css`, `trimble-assist-ok-menus.json`,
`w_main.jsp`, then `touch web.xml`. Reload completed.

## How to test

1. Hard-refresh AMS. Console: `Loaded v=20260814b` and `window catalog=563`.
2. New chat, Haiku. Ask: **take me to Day Cards**.
3. Agent should call `search_windows` / `open_window` and land on Roadway Day Cards.
4. Work Assist stays open on the same thread.

## Open follow-ups

- [x] Phase 2: location chip includes `menu_id`; `get_window_identity`. See `2026-08-14-helper-jira-logs.md`.
- [ ] Live `SYSTEM_MENU` query instead of a packaged CSV.
- [ ] Permanent `agents` + Kernel files in the image (week before AISummit 3.0).
- [ ] Quiet `models-api …/usage` 401/CORS.
- [ ] Setup-guide PDF/HTML.
