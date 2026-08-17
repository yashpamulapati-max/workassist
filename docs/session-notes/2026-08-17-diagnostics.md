# Work Assist — Session Notes (2026-08-17)

Live embed on `ams-ok-yp2`. Cache-bust: **`?v=20260817a`**.
Console: `[WorkAssist] Loaded v=20260817a`.

Embed snapshot: [`embed/Kernel/`](../../embed/Kernel/).

---

## Diagnostics overlay (copy folded into logs)

Header is now **logs / expand / close**. Copy is no longer a top-bar icon.

The log button opens **Diagnostics**:

- Login-style version from `w_login.jsp` (`Version PROD Build 9.2.0` + `9.2.0-RELEASE - commit … - built …`)
- `build.html` number / date / branch / commit
- Current window breadcrumb + `menu_id`
- High-contrast `ams-web.log` tail (last ~250 KB). ERROR / WARN / INFO colored.
- Clipboard (copy for Jira) lives **inside** this overlay

Log text was unreadable because AMS `pre` styles washed out the overlay. The body is now a `div` with forced near-white color on `#0d1117`.

## Deploy

Same pod `ams-ok-yp2-ams-web-assetmgm-7b75596b55-mzv6q` (not recreated). Pushed Kernel files, `touch web.xml`, reload completed 17-Aug 14:52:48.

## Open follow-ups

- [ ] Live `SYSTEM_MENU` query instead of packaged CSV
- [ ] Permanent `agents` + Kernel files in the image (week before AISummit 3.0)
- [ ] Quiet `models-api …/usage` 401/CORS
