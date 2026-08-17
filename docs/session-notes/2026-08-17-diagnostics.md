# Work Assist — Session Notes (2026-08-17)

Live embed on `ams-ok-yp2`. Cache-bust: **`?v=20260817d`**.
Console: `[WorkAssist] Loaded v=20260817d`.

Embed snapshot: [`embed/Kernel/`](../../embed/Kernel/).

---

## Diagnostics overlay (copy folded into logs)

Header is **logs / expand / close**. Copy is not a top-bar icon.

The log button opens **Diagnostics** on the current window (does **not** auto-navigate to System Logs):

- Login-style version from `w_login.jsp` (`Version PROD Build 9.2.0` + `9.2.0-RELEASE - commit … - built …`)
- `build.html` number / date / branch / commit
- Clickable path: **`System > Tools > Logs · system_log`**
- Current window shown separately when you are not already on Logs
- Clipboard (copy for Jira) lives **inside** this overlay
- High-contrast `ams-web.log` tail (last ~250 KB). ERROR / WARN / INFO colored — **only after System Logs is the active window**

Log text was unreadable because AMS `pre` styles washed out the overlay. The body is a `div` with forced near-white color on `#0d1117`.

## Clickable Logs path (no auto-redirect)

AMS has no HTTP tail API. `download_file` / `get_file` only work on the System Logs work frame (`sc_sl`).

- Header icon keeps chat on the current screen and shows Diagnostics.
- Click the green path to open Logs; the panel restores after `w_main.jsp` reload (`ta-show-log`). ⌘/Ctrl-click opens a new session so this chat stays put.
- Live tail then appears in Diagnostics.

## Reverted: hidden iframe fetch (`v=20260817c`)

Tried loading System Logs in a hidden `build_work_page` iframe so the tail could show on Dashboard. That broke AMS:

- `Debug. not_found is invalid window ID.`
- “Open in design mode?”
- Stuck “Page Loading…” overlay

Reverted in **`v=20260817d`**. Do not retry that approach without a dedicated log API.

## Deploy

Same pod `ams-ok-yp2-ams-web-assetmgm-7b75596b55-mzv6q`. Latest push: Kernel files + `touch web.xml`, reload completed 17-Aug 16:06:47.

## Open follow-ups

- [ ] Live `SYSTEM_MENU` query instead of packaged CSV
- [ ] Permanent `agents` + Kernel files in the image (week before AISummit 3.0)
- [ ] Quiet `models-api …/usage` 401/CORS
- [ ] Dedicated log-tail API (so Diagnostics does not need the System Logs window)
