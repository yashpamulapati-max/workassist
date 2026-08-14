/**
 * Trimble Agentic AI – AgileAssets Integration
 *
 * Embeds the Trimble Assist chat as a floating panel inside the AgileAssets
 * web application.  Registers local tools that proxy calls to the AgileAssets
 * REST V2 API so the AI agent can query and create work orders, work
 * requests, assets, etc.
 *
 * Dependencies:
 *   - window.GVars (populated by w_gvars.jsp) must be available.
 *   - Optionally: @trimble-agentic-external-npm-local/agentic-platform-sdk-iframe-typescript
 *     for the official listenToChatUi helper.  If the SDK is not present the
 *     script falls back to a lightweight postMessage bridge.
 */
(function () {
    "use strict";

    // -----------------------------------------------------------------------
    // Configuration
    // -----------------------------------------------------------------------

    var AGENT_ID  = "37242c15-9716-4b91-9032-e8f7390d1d80"; // Work Assist
    var ENV       = "stage";
    var THEME     = "dark";

    // Embeddable Chat UI domains. Unlike assist.*.trimble-ai.com (which sends
    // X-Frame-Options: DENY and cannot be iframed), the embed.* domains allow
    // framing. These mirror the SDK's CHAT_UI_URLS; when the SDK bundle is
    // present we defer to window.TrimbleAgenticSDK.CHAT_UI_URLS.
    var CHAT_UI_URLS = {
        development: "https://embed.dev.trimble-ai.com",
        stage:       "https://embed.stage.trimble-ai.com",
        prod:        "https://embed.ai.trimble.com"
    };

    var CHAT_UI_URL = CHAT_UI_URLS[ENV];
    var ASSET_VER = "20260814d";

    // w_main.jsp reloads on every window change (OnChangeCurrentWindow), which
    // destroys the panel. sessionStorage survives that same-tab navigation.
    var TA_OPEN = "ta-panel-open";
    var TA_EXPANDED = "ta-panel-expanded";
    var TA_THREAD = "ta-thread-id";
    var TA_SHOW_LOG = "ta-show-log";

    function taGet(key) {
        try { return sessionStorage.getItem(key); } catch (e) { return null; }
    }
    function taSet(key, value) {
        try {
            if (value == null || value === "") sessionStorage.removeItem(key);
            else sessionStorage.setItem(key, String(value));
        } catch (e) { /* private mode */ }
    }
    function extractThreadId(ev) {
        if (!ev || typeof ev !== "object") return "";
        var nested = ev.thread || ev.payload || ev.data || {};
        var id = ev.threadId || ev.thread_id ||
            nested.threadId || nested.thread_id || nested.id ||
            (nested.thread && (nested.thread.id || nested.thread.threadId));
        return id ? String(id) : "";
    }

    var MCP_SESSION_ID = null;

    // -----------------------------------------------------------------------
    // Helpers – API base URL derived from GVars
    // -----------------------------------------------------------------------

    function getApiBase() {
        var root = window.GVars && window.GVars.application_root;
        if (root) {
            return root.replace(/\/$/, "") + "/rest/v2";
        }
        return window.location.origin +
               window.location.pathname.replace(/\/Kernel.*/, "") + "/rest/v2";
    }

    function getAppRoot() {
        var root = window.GVars && window.GVars.application_root;
        if (root) return String(root).replace(/\/$/, "");
        return window.location.origin +
               window.location.pathname.replace(/\/Kernel.*/, "");
    }

    function getAuthHeaders() {
        return {
            "Authorization": "Bearer " + window.GVars.access_token,
            "Content-Type":  "application/json",
            "AA_SID":        window.GVars.aa_sid
        };
    }

    function parseJsonArg(v) {
        if (v == null || v === "") return null;
        if (typeof v === "object") return v;
        if (typeof v === "string") {
            try { return JSON.parse(v); } catch (e) { return null; }
        }
        return null;
    }

    function apiRequest(method, endpoint, params, body) {
        method = String(method || "GET").toUpperCase();
        endpoint = String(endpoint || "").replace(/^\/+/, "").replace(/^rest\/v2\//i, "");
        var url = getApiBase() + "/" + endpoint;
        params = parseJsonArg(params) || params;
        body = parseJsonArg(body) || body;
        if (params && typeof params === "object") {
            var qs = Object.keys(params).filter(function (k) {
                return params[k] !== undefined && params[k] !== null && params[k] !== "";
            }).map(function (k) {
                var v = params[k];
                if (typeof v === "object") v = JSON.stringify(v);
                return encodeURIComponent(k) + "=" + encodeURIComponent(v);
            }).join("&");
            if (qs) url += (url.indexOf("?") >= 0 ? "&" : "?") + qs;
        }
        var opts = { method: method, headers: getAuthHeaders() };
        if (body && method !== "GET" && method !== "HEAD") {
            opts.body = typeof body === "string" ? body : JSON.stringify(body);
        }
        return fetch(url, opts).then(function (r) {
            return r.text().then(function (text) {
                var parsed = text;
                try { parsed = text ? JSON.parse(text) : null; } catch (e) { /* keep raw */ }
                var out = { ok: r.ok, status: r.status, method: method, url: url, body: parsed };
                var s = JSON.stringify(out);
                if (s.length > 14000) {
                    out.body = { truncated: true, length: s.length, preview: s.slice(0, 9000) };
                    s = JSON.stringify(out);
                }
                return s;
            });
        }).catch(function (e) {
            return JSON.stringify({ ok: false, error: e.message, method: method, url: url });
        });
    }

    function apiGet(endpoint, params) {
        return apiRequest("GET", endpoint, params).then(function (s) {
            var o = JSON.parse(s);
            return JSON.stringify(o.body !== undefined ? o.body : o);
        });
    }

    function apiPost(endpoint, body) {
        return apiRequest("POST", endpoint, null, body).then(function (s) {
            var o = JSON.parse(s);
            return JSON.stringify(o.body !== undefined ? o.body : o);
        });
    }

    function apiPut(endpoint, body) {
        return apiRequest("PUT", endpoint, null, body).then(function (s) {
            var o = JSON.parse(s);
            return JSON.stringify(o.body !== undefined ? o.body : o);
        });
    }

    function apiDelete(endpoint, params) {
        return apiRequest("DELETE", endpoint, params).then(function (s) {
            var o = JSON.parse(s);
            return JSON.stringify(o.body !== undefined ? o.body : o);
        });
    }

    var API_SPEC = null;
    var API_CATALOG = null;

    function getOpenApiUrl() {
        var root = window.GVars && window.GVars.application_root;
        if (root) return root.replace(/\/$/, "") + "/openapi/v2/openapi.json";
        return window.location.origin +
               window.location.pathname.replace(/\/Kernel.*/, "") + "/openapi/v2/openapi.json";
    }

    function loadApiCatalog() {
        if (API_CATALOG) return Promise.resolve(API_CATALOG);
        return fetch(getOpenApiUrl(), { headers: getAuthHeaders(), credentials: "same-origin" })
            .then(function (r) { return r.json(); })
            .then(function (spec) {
                API_SPEC = spec;
                var cat = [];
                var paths = spec.paths || {};
                Object.keys(paths).forEach(function (p) {
                    Object.keys(paths[p]).forEach(function (m) {
                        if (m.indexOf("x-") === 0) return;
                        var op = paths[p][m] || {};
                        cat.push({
                            method: m.toUpperCase(),
                            path: p,
                            tag: (op.tags && op.tags[0]) || "",
                            summary: op.summary || op.operationId || "",
                            operationId: op.operationId || ""
                        });
                    });
                });
                API_CATALOG = cat;
                return cat;
            });
    }

    // -----------------------------------------------------------------------
    // MCP proxy – calls the Python MCP server running inside the K8s pod
    // -----------------------------------------------------------------------

    function getMcpUrl() {
        var root = window.GVars && window.GVars.application_root;
        if (root) return root.replace(/\/$/, "") + "/mcp";
        return window.location.origin +
               window.location.pathname.replace(/\/Kernel.*/, "") + "/mcp";
    }

    function mcpCall(method, params) {
        var headers = {
            "Content-Type": "application/json",
            "Accept": "application/json, text/event-stream"
        };
        if (MCP_SESSION_ID) headers["Mcp-Session-Id"] = MCP_SESSION_ID;

        var body = {
            jsonrpc: "2.0",
            id: Date.now(),
            method: method,
            params: params || {}
        };

        return fetch(getMcpUrl(), { method: "POST", headers: headers, body: JSON.stringify(body) })
            .then(function (r) {
                var sid = r.headers.get("Mcp-Session-Id");
                if (sid) MCP_SESSION_ID = sid;
                return r.json();
            });
    }

    function ensureMcpSession() {
        if (MCP_SESSION_ID) return Promise.resolve();
        return mcpCall("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "TrimbleAssist", version: "1.0" }
        });
    }

    function mcpToolCall(toolName, args) {
        return ensureMcpSession().then(function () {
            return mcpCall("tools/call", { name: toolName, arguments: args });
        }).then(function (resp) {
            if (resp.result && resp.result.content) {
                return resp.result.content.map(function (c) { return c.text; }).join("\n");
            }
            return JSON.stringify(resp.result || resp.error || resp);
        });
    }

    // -----------------------------------------------------------------------
    // DOM Interaction Layer – access the AgileAssets UI inside wrk_frame
    // -----------------------------------------------------------------------

    function getWorkFrame() {
        try {
            var f = document.getElementById("wrk_frame");
            return f && f.contentWindow ? f.contentWindow : null;
        } catch (e) { return null; }
    }

    function getBasicWindow() {
        var wf = getWorkFrame();
        return wf && wf.basic_window ? wf.basic_window : null;
    }

    function getDataWindowByName(name) {
        var wf = getWorkFrame();
        if (!wf) return null;
        if (wf[name]) return wf[name];
        var bw = wf.basic_window;
        if (bw && bw.IsObjectValid && bw.IsObjectValid(name)) return wf[name];
        return null;
    }

    function getWindowTitle() {
        var bw = getBasicWindow();
        var wf = getWorkFrame();
        var title = "";
        try {
            if (bw && typeof bw.GetTitle === "function") title = bw.GetTitle() || "";
            if (!title && wf && wf.document) title = wf.document.title || "";
        } catch (e) { /* cross-origin or unloaded frame */ }
        title = String(title || "").replace(/^\*\s*/, "").replace(/\s+/g, " ").trim();
        if (!title || title === "undefined") return "";
        return title;
    }

    function getActiveNavLabel() {
        function fromDoc(doc) {
            if (!doc || !doc.querySelector) return "";
            var el = doc.querySelector(
                ".modus-side-navigation-item.active, .aa-nav-item.active, " +
                "[aria-current='page'], .menu_item.selected, .selected.menu_item"
            );
            if (!el) return "";
            return String(el.textContent || "").replace(/\s+/g, " ").trim();
        }
        var label = fromDoc(document);
        if (label) return label;
        try {
            var wf = getWorkFrame();
            if (wf) return fromDoc(wf.document);
        } catch (e) { /* ignore */ }
        return "";
    }

    function getLocationLabel() {
        var title = getWindowTitle();
        var nav = getActiveNavLabel();
        var moduleName = (window.GVars && (window.GVars.module_name || window.GVars.module_label)) || "";
        if (nav && title && nav.toLowerCase() !== title.toLowerCase()) return nav + " › " + title;
        if (title) return title;
        if (nav) return nav;
        if (moduleName) return String(moduleName);
        return "No window open";
    }

    // Oklahoma SYSTEM_MENU catalog (from Helper extension OK_menus.csv).
    // Navigate with w_main.jsp?AA_SID=&menu_id= — do not click the menu tree.
    var WINDOW_CATALOG = [];
    var WINDOW_CATALOG_READY = null;

    function loadWindowCatalog() {
        if (WINDOW_CATALOG_READY) return WINDOW_CATALOG_READY;
        var url = "trimble-assist-ok-menus.json?v=" + ASSET_VER;
        try {
            url = new URL("trimble-assist-ok-menus.json?v=" + ASSET_VER, window.location.href).href;
        } catch (e) { /* keep relative */ }
        WINDOW_CATALOG_READY = fetch(url, { cache: "no-store" })
            .then(function (r) { return r.ok ? r.json() : []; })
            .then(function (rows) {
                WINDOW_CATALOG = Array.isArray(rows) ? rows : [];
                console.log("[WorkAssist] window catalog=" + WINDOW_CATALOG.length);
                return WINDOW_CATALOG;
            })
            .catch(function (e) {
                WINDOW_CATALOG = [];
                console.warn("[WorkAssist] window catalog failed", e);
                return WINDOW_CATALOG;
            });
        return WINDOW_CATALOG_READY;
    }

    function taNorm(s) {
        return String(s || "").toLowerCase().replace(/\s+/g, " ").trim();
    }

    function getAaSid() {
        try {
            return new URL(window.location.href).searchParams.get("AA_SID") || "";
        } catch (e) {
            var m = String(window.location.search || "").match(/[?&]AA_SID=([^&]+)/);
            return m ? decodeURIComponent(m[1]) : "";
        }
    }

    function getCurrentMenuId() {
        try {
            return new URL(window.location.href).searchParams.get("menu_id") || "";
        } catch (e) {
            var m = String(window.location.search || "").match(/[?&]menu_id=([^&]+)/);
            return m ? decodeURIComponent(m[1]) : "";
        }
    }

    function searchWindows(query, limit) {
        limit = limit || 12;
        var q = taNorm(query);
        if (!q || !WINDOW_CATALOG.length) return [];
        var keywords = q.split(" ").filter(Boolean);
        var loc = taNorm(getLocationLabel());
        var results = [];
        for (var i = 0; i < WINDOW_CATALOG.length; i++) {
            var item = WINDOW_CATALOG[i];
            var label = taNorm(item.label);
            var path = taNorm(item.path);
            var id = taNorm(item.id);
            var hay = label + " " + path + " " + id.replace(/_/g, " ");
            var all = true;
            for (var k = 0; k < keywords.length; k++) {
                if (hay.indexOf(keywords[k]) < 0) { all = false; break; }
            }
            if (!all) continue;
            var score = 0;
            if (label === q || id === q) score += 100;
            else if (label.indexOf(q) === 0) score += 80;
            else if (label.indexOf(q) >= 0) score += 60;
            if (id.indexOf(q) >= 0) score += 40;
            if (path.indexOf(q) >= 0) score += 25;
            for (var ki = 0; ki < keywords.length; ki++) {
                if (label.indexOf(keywords[ki]) >= 0) score += 8;
                if (path.indexOf(keywords[ki]) >= 0) score += 4;
            }
            if (/\(n\/a\)/.test(path)) score -= 15;
            var first = path.split(">")[0].trim();
            if (loc && first && loc.indexOf(first) >= 0) score += 20;
            if (/roadway/.test(path) && /day card|work order|\bwo\b/.test(q)) score += 12;
            results.push({ score: score, id: item.id, label: item.label, path: item.path });
        }
        results.sort(function (a, b) { return b.score - a.score; });
        return results.slice(0, limit);
    }

    function taEsc(s) {
        return String(s || "").replace(/[&<>"']/g, function (c) {
            return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
        });
    }

    function navigateToMenuId(menuId, openInNewTab) {
        var sid = getAaSid();
        if (!sid) {
            return { error: "No AA_SID on this page. Stay on w_main.jsp after SSO login." };
        }
        if (!menuId) return { error: "menu_id is required" };
        var base = window.location.href.split("?")[0];
        var qs = "?AA_SID=" + encodeURIComponent(sid) +
            "&menu_id=" + encodeURIComponent(menuId);
        if (openInNewTab) {
            var nav = base.replace(/w_main\.jsp/gi, "w_navigation.jsp");
            window.open(nav + qs, "_blank");
            return { success: true, newTab: true, menu_id: menuId };
        }
        window.location.href = base + qs;
        return { success: true, navigating: true, menu_id: menuId };
    }

    function getBreadcrumbText() {
        function fromDoc(doc) {
            if (!doc || !doc.querySelector) return "";
            var nav = doc.querySelector('nav[aria-label="breadcrumb"]');
            if (nav) {
                var items = nav.querySelectorAll("li.breadcrumb-item");
                var parts = [];
                for (var i = 0; i < items.length; i++) {
                    var t = String(items[i].textContent || "").replace(/\s+/g, " ").trim();
                    if (t) parts.push(t);
                }
                if (parts.length) return parts.join(" > ");
            }
            var crumbs = doc.getElementById("breadcrumbs");
            if (crumbs) {
                var raw = String(crumbs.textContent || "").replace(/\s+/g, " ").trim();
                if (raw) return raw;
            }
            return "";
        }
        var b = fromDoc(document);
        if (b) return b;
        try {
            var wf = getWorkFrame();
            if (wf) b = fromDoc(wf.document);
        } catch (e) { /* ignore */ }
        if (b) return b;
        var mid = getCurrentMenuId();
        var hits = WINDOW_CATALOG.filter(function (w) { return w.id === mid; });
        if (hits[0] && hits[0].path) return hits[0].path;
        return getLocationLabel();
    }

    function parseBuildHtml(htmlText) {
        var getValue = function (key) {
            var m = String(htmlText || "").match(new RegExp(key + ':\\s*"([^"]*)"'));
            return m ? m[1] : "";
        };
        return {
            number: getValue("Build number"),
            date: getValue("Build date"),
            branch: getValue("Branch"),
            commit: getValue("Commit-ID"),
            version: getValue("Version")
        };
    }

    function fetchBuildInfo() {
        return fetch(getAppRoot() + "/build.html", { cache: "no-store", credentials: "same-origin" })
            .then(function (r) { return r.ok ? r.text() : ""; })
            .then(parseBuildHtml)
            .catch(function () { return { number: "", date: "", branch: "", commit: "", version: "" }; });
    }

    function buildJiraSnippet(build) {
        var g = window.GVars || {};
        var mid = getCurrentMenuId();
        var crumb = getBreadcrumbText();
        var lines = [
            "AgileAssets bug context",
            "URL: " + window.location.href,
            "Window: " + crumb + (mid ? " (" + mid + ")" : ""),
            "User: " + (g.user_id || "") + " / " + (g.owner_name || g.owner_id || ""),
            "Env: " + (g.customer_project_id || "") + " module=" + (g.module_id || ""),
            "",
            getAppRoot() + "/Kernel/w_login.jsp",
            "",
            'Build number: "' + (build.number || "") + '"',
            'Build date: "' + (build.date || "") + '"',
            'Branch: "' + (build.branch || "") + '"',
            'Commit-ID: "' + (build.commit || "") + '"',
            'Version: "' + (build.version || "") + '"'
        ];
        return lines.join("\n");
    }

    function fetchAmsWebLog() {
        var wf = getWorkFrame();
        if (!wf || !wf.sc_sl || !wf.CHTTPParam || !wf.basic_window) {
            return Promise.reject(new Error("not-on-logs"));
        }
        var ok = wf.sc_sl.Execute(
            new wf.CHTTPParam("command_id", "download_file"),
            new wf.CHTTPParam("file_name", "ams-web.log")
        );
        if (ok != 1) {
            return Promise.reject(new Error("download_file returned " + ok));
        }
        var bw = wf.basic_window;
        var csrfQs = "";
        try {
            if (typeof csrf === "function") csrfQs = csrf();
            else if (typeof wf.csrf === "function") csrfQs = wf.csrf();
        } catch (e) { /* ignore */ }
        var url = getAppRoot() + "/ControllerServlet?AA_SID=" + encodeURIComponent(getAaSid()) +
            "&action_id=window_service&command_id=get_file" +
            "&window_id=" + encodeURIComponent(bw.GetWindowId()) +
            "&window_instance_id=" + encodeURIComponent(bw.GetWindowInstanceId()) +
            "&timestamp=" + Date.now() + csrfQs;
        return fetch(url, { method: "POST", credentials: "same-origin" }).then(function (r) {
            if (!r.ok) throw new Error("get_file HTTP " + r.status);
            return r.text();
        }).then(function (text) {
            text = String(text || "");
            if (text.length > 250000) text = text.slice(text.length - 250000);
            return text;
        });
    }

    function resolveAndOpenWindow(args) {
        var menuId = String((args && (args.menu_id || args.menuId)) || "").trim();
        var query = String((args && (args.query || args.menuPath || args.menu_path)) || "").trim();
        if (menuId) {
            var known = WINDOW_CATALOG.filter(function (w) { return w.id === menuId; });
            var nav = navigateToMenuId(menuId);
            nav.matches = known;
            return nav;
        }
        if (!query) {
            return { error: "Provide menu_id or query (window name / path)." };
        }
        var matches = searchWindows(query, 8);
        if (!matches.length) {
            return { error: "No catalog match", query: query, hint: "Call search_windows with a shorter name." };
        }
        var top = matches[0];
        var second = matches[1];
        var unique = !second || (top.score - second.score >= 12) || top.id === (second && second.id);
        if (unique && top.score >= 50) {
            var opened = navigateToMenuId(top.id);
            opened.chose = top;
            opened.alternates = matches.slice(1, 4);
            return opened;
        }
        return {
            needsChoice: true,
            message: "Multiple windows match. Call open_window with one menu_id.",
            matches: matches
        };
    }

    function getPromptsForLocation(label) {
        var key = String(label || "").toLowerCase();
        if (/day\s*card|work\s*order|\bwo\b/.test(key)) {
            return [
                "How do I insert a Day Card / Work Order on this screen?",
                "Which fields are required before I can Save?",
                "How do I assign labor, equipment, and material after the WO is created?"
            ];
        }
        if (/work\s*request/.test(key)) {
            return [
                "How do I create a work request from this window?",
                "What is the difference between a work request and a work order?"
            ];
        }
        if (/fleet|equipment|odometer/.test(key)) {
            return [
                "How do I record an odometer reading?",
                "How do I find equipment assigned to my crew?"
            ];
        }
        if (/asset/.test(key)) {
            return [
                "How do I look up an asset on this screen?",
                "What does this window expect me to fill in?"
            ];
        }
        return [
            "What can I do on this window?",
            "What is required before I click Save?"
        ];
    }

    function findAllDataWindows() {
        var wf = getWorkFrame();
        if (!wf) return [];
        var result = [];
        try {
            for (var key in wf) {
                try {
                    var obj = wf[key];
                    if (obj && typeof obj === "object" && typeof obj.RowCount === "function"
                        && typeof obj.ColumnCount === "function" && typeof obj.GetItem === "function") {
                        result.push(key);
                    }
                } catch (e) { /* skip inaccessible */ }
            }
        } catch (e) { /* cross-origin */ }
        return result;
    }

    function readGridData(dwName, maxRows) {
        var dw = getDataWindowByName(dwName);
        if (!dw) return { error: "DataWindow '" + dwName + "' not found" };
        var rowCount = dw.RowCount();
        var colCount = dw.ColumnCount();
        var limit = Math.min(rowCount, maxRows || 50);
        var columns = [];
        for (var c = 1; c <= colCount; c++) {
            columns.push({
                index: c,
                name: dw.GetColumnName ? dw.GetColumnName(c) : ("col_" + c),
                label: dw.GetColumnLabel ? dw.GetColumnLabel(c) : ""
            });
        }
        var rows = [];
        for (var r = 1; r <= limit; r++) {
            var row = { _row: r };
            for (var ci = 0; ci < columns.length; ci++) {
                var col = columns[ci];
                try { row[col.name] = dw.GetItem(r, col.index); } catch (e) { row[col.name] = null; }
            }
            rows.push(row);
        }
        return {
            datawindow: dwName,
            totalRows: rowCount,
            returnedRows: limit,
            currentRow: dw.GetRow ? dw.GetRow() : null,
            columns: columns,
            rows: rows
        };
    }

    function getMenuItems(dwName) {
        var dw = getDataWindowByName(dwName);
        if (!dw || !dw.GetMenu) return { error: "DataWindow '" + dwName + "' not found or has no menu" };
        var menu = dw.GetMenu();
        if (!menu || !menu.GetMenuItems) return { error: "No menu on " + dwName };
        var items = menu.GetMenuItems();
        var result = [];
        if (items && items.length) {
            for (var i = 0; i < items.length; i++) {
                var mi = items[i];
                result.push({
                    id: mi.GetId ? mi.GetId() : ("item_" + i),
                    label: mi.GetLabel ? mi.GetLabel() : "",
                    hidden: mi.IsHidden ? mi.IsHidden() : false,
                    enabled: mi.IsEnabled ? mi.IsEnabled() : true
                });
            }
        }
        return { datawindow: dwName, menuItems: result };
    }

    function highlightElement(el, color) {
        if (!el) return;
        var orig = el.style.outline;
        el.style.outline = "3px solid " + (color || "#00e676");
        setTimeout(function () { el.style.outline = orig; }, 1500);
    }

    // -----------------------------------------------------------------------
    // Local tools – these are invoked by the Trimble AI agent via the iframe
    // -----------------------------------------------------------------------

    var LOCAL_TOOLS = {

        // --- Oracle DB (via MCP server) ---
        run_sql: {
            definition: {
                name: "run_sql",
                description: "Execute a read-only SQL SELECT query against the AMS_OK_YP Oracle database. Returns columns and row data. Only SELECT statements allowed.",
                parameters: {
                    type: "object",
                    properties: {
                        sql:      { type: "string", description: "The SELECT query to run" },
                        max_rows: { type: "number", description: "Max rows to return (default 500)" }
                    },
                    required: ["sql"]
                }
            },
            callback: function (args) {
                return mcpToolCall("run_sql", { sql: args.sql, max_rows: args.max_rows || 500 });
            },
            timeOutInMs: 60000
        },

        run_dml: {
            definition: {
                name: "run_dml",
                description: "Execute a DML statement (INSERT, UPDATE, DELETE) against the Oracle database. Commits automatically. USE WITH CAUTION.",
                parameters: {
                    type: "object",
                    properties: {
                        sql: { type: "string", description: "The DML statement to run" }
                    },
                    required: ["sql"]
                }
            },
            callback: function (args) {
                return mcpToolCall("run_dml", { sql: args.sql });
            },
            timeOutInMs: 60000
        },

        list_tables: {
            definition: {
                name: "list_tables",
                description: "List tables in the Oracle database. Filter by schema and name pattern.",
                parameters: {
                    type: "object",
                    properties: {
                        schema:       { type: "string", description: "Schema/owner (default AMS_OK)" },
                        name_pattern: { type: "string", description: "SQL LIKE pattern (default %, e.g. 'WR_%')" }
                    }
                }
            },
            callback: function (args) {
                return mcpToolCall("list_tables", { schema: args.schema || "AMS_OK", name_pattern: args.name_pattern || "%" });
            },
            timeOutInMs: 30000
        },

        describe_table: {
            definition: {
                name: "describe_table",
                description: "Describe columns of a table: name, data type, nullable, length.",
                parameters: {
                    type: "object",
                    properties: {
                        table_name: { type: "string", description: "Table name" },
                        schema:     { type: "string", description: "Schema/owner (default AMS_OK)" }
                    },
                    required: ["table_name"]
                }
            },
            callback: function (args) {
                return mcpToolCall("describe_table", { table_name: args.table_name, schema: args.schema || "AMS_OK" });
            },
            timeOutInMs: 30000
        },

        search_tables: {
            definition: {
                name: "search_tables",
                description: "Search for tables and columns containing a keyword. Useful for discovery.",
                parameters: {
                    type: "object",
                    properties: {
                        keyword: { type: "string", description: "Keyword to search in table/column names" },
                        schema:  { type: "string", description: "Schema/owner (default AMS_OK)" }
                    },
                    required: ["keyword"]
                }
            },
            callback: function (args) {
                return mcpToolCall("search_tables", { keyword: args.keyword, schema: args.schema || "AMS_OK" });
            },
            timeOutInMs: 30000
        },

        table_sample: {
            definition: {
                name: "table_sample",
                description: "Get a sample of rows from a table.",
                parameters: {
                    type: "object",
                    properties: {
                        table_name:   { type: "string", description: "Table name" },
                        schema:       { type: "string", description: "Schema/owner (default AMS_OK)" },
                        num_rows:     { type: "number", description: "Number of rows (default 10)" },
                        where_clause: { type: "string", description: "Optional WHERE condition (without WHERE keyword)" }
                    },
                    required: ["table_name"]
                }
            },
            callback: function (args) {
                return mcpToolCall("table_sample", {
                    table_name: args.table_name,
                    schema: args.schema || "AMS_OK",
                    num_rows: args.num_rows || 10,
                    where_clause: args.where_clause || ""
                });
            },
            timeOutInMs: 30000
        },

        // --- Work Requests ---
        list_work_requests: {
            definition: {
                name: "list_work_requests",
                description: "List work requests from AgileAssets. Returns id, status, description, reported date, admin unit, activity.",
                parameters: {
                    type: "object",
                    properties: {
                        limit:  { type: "number", description: "Max records (default 20)" },
                        offset: { type: "number", description: "Pagination offset" }
                    }
                }
            },
            callback: function (args) {
                return apiGet("workrequests", { limit: args.limit || 20, offset: args.offset || 0 })
                    .then(function (r) { return JSON.stringify(r); });
            },
            timeOutInMs: 30000
        },

        get_work_request: {
            definition: {
                name: "get_work_request",
                description: "Get a single work request by ID. Returns full details including status, location, description.",
                parameters: {
                    type: "object",
                    properties: {
                        id: { type: "number", description: "Work request ID" }
                    },
                    required: ["id"]
                }
            },
            callback: function (args) {
                return apiGet("workrequests/" + args.id)
                    .then(function (r) { return JSON.stringify(r); });
            },
            timeOutInMs: 15000
        },

        create_work_request: {
            definition: {
                name: "create_work_request",
                description: "Create a new work request. Requires typeId, adminUnitId, activityId, inWrDescription, reportedDate (yyyyMMddHHmmss).",
                parameters: {
                    type: "object",
                    properties: {
                        typeId:            { type: "number", description: "Work request type ID" },
                        adminUnitId:       { type: "number", description: "Admin unit ID" },
                        activityId:        { type: "number", description: "Activity ID" },
                        inWrDescription:   { type: "string", description: "Description" },
                        reportedDate:      { type: "string", description: "Date in yyyyMMddHHmmss format" }
                    },
                    required: ["typeId", "adminUnitId", "inWrDescription"]
                }
            },
            callback: function (args) {
                return apiPost("workrequests", args)
                    .then(function (r) { return JSON.stringify(r); });
            },
            timeOutInMs: 30000
        },

        // --- Work Orders ---
        list_work_orders: {
            definition: {
                name: "list_work_orders",
                description: "List work orders from AgileAssets. Returns id, status, activity, crew, dates, costs.",
                parameters: {
                    type: "object",
                    properties: {
                        limit:  { type: "number", description: "Max records (default 20)" },
                        offset: { type: "number", description: "Pagination offset" }
                    }
                }
            },
            callback: function (args) {
                return apiGet("workorders", { limit: args.limit || 20, offset: args.offset || 0 })
                    .then(function (r) { return JSON.stringify(r); });
            },
            timeOutInMs: 30000
        },

        get_work_order: {
            definition: {
                name: "get_work_order",
                description: "Get a single work order by ID with full details.",
                parameters: {
                    type: "object",
                    properties: {
                        workOrderID: { type: "number", description: "Work order ID" }
                    },
                    required: ["workOrderID"]
                }
            },
            callback: function (args) {
                return apiGet("workorders/" + args.workOrderID)
                    .then(function (r) { return JSON.stringify(r); });
            },
            timeOutInMs: 15000
        },

        create_work_order: {
            definition: {
                name: "create_work_order",
                description: "Create a new work order. Requires adminUnitId, activityId, statusId, scheduledDate.",
                parameters: {
                    type: "object",
                    properties: {
                        adminUnitId:   { type: "number", description: "Admin unit ID" },
                        activityId:    { type: "number", description: "Activity ID" },
                        statusId:      { type: "number", description: "Initial status ID" },
                        scheduledDate: { type: "string", description: "Date in yyyyMMddHHmmss format" },
                        crewId:        { type: "number", description: "Crew ID (optional)" }
                    },
                    required: ["adminUnitId", "activityId"]
                }
            },
            callback: function (args) {
                return apiPost("workorders", args)
                    .then(function (r) { return JSON.stringify(r); });
            },
            timeOutInMs: 30000
        },

        update_work_order: {
            definition: {
                name: "update_work_order",
                description: "Update an existing work order by ID.",
                parameters: {
                    type: "object",
                    properties: {
                        workOrderID: { type: "number", description: "Work order ID to update" },
                        data:        { type: "object", description: "Fields to update" }
                    },
                    required: ["workOrderID", "data"]
                }
            },
            callback: function (args) {
                return apiPut("workorders/" + args.workOrderID, args.data)
                    .then(function (r) { return JSON.stringify(r); });
            },
            timeOutInMs: 30000
        },

        // --- Assets ---
        list_assets: {
            definition: {
                name: "list_assets",
                description: "List assets from AgileAssets inventory.",
                parameters: {
                    type: "object",
                    properties: {
                        limit:  { type: "number", description: "Max records (default 20)" },
                        offset: { type: "number", description: "Pagination offset" }
                    }
                }
            },
            callback: function (args) {
                return apiGet("assets", { limit: args.limit || 20, offset: args.offset || 0 })
                    .then(function (r) { return JSON.stringify(r); });
            },
            timeOutInMs: 30000
        },

        list_asset_types: {
            definition: {
                name: "list_asset_types",
                description: "List available asset types and their IDs.",
                parameters: { type: "object", properties: {} }
            },
            callback: function () {
                return apiGet("assetType")
                    .then(function (r) { return JSON.stringify(r); });
            },
            timeOutInMs: 15000
        },

        // --- Reference Data ---
        list_activities: {
            definition: {
                name: "list_activities",
                description: "List maintenance activities (activity types). Use to find valid activityId values.",
                parameters: { type: "object", properties: { limit: { type: "number" } } }
            },
            callback: function (args) {
                return apiGet("activity", { limit: args.limit || 100 })
                    .then(function (r) { return JSON.stringify(r); });
            },
            timeOutInMs: 15000
        },

        list_admin_units: {
            definition: {
                name: "list_admin_units",
                description: "List admin units (organizational districts). Use to find valid adminUnitId values.",
                parameters: { type: "object", properties: { limit: { type: "number" } } }
            },
            callback: function (args) {
                return apiGet("adminunit", { limit: args.limit || 100 })
                    .then(function (r) { return JSON.stringify(r); });
            },
            timeOutInMs: 15000
        },

        list_crews: {
            definition: {
                name: "list_crews",
                description: "List available maintenance crews.",
                parameters: { type: "object", properties: { limit: { type: "number" } } }
            },
            callback: function (args) {
                return apiGet("crew", { limit: args.limit || 100 })
                    .then(function (r) { return JSON.stringify(r); });
            },
            timeOutInMs: 15000
        },

        // --- DOM Interaction: Reading ---
        dom_get_page_context: {
            definition: {
                name: "dom_get_page_context",
                description: "Get the current page context: which window is loaded, available datawindows/grids, current user, admin unit. Use this first to understand what the user is looking at.",
                parameters: { type: "object", properties: {} }
            },
            callback: function () {
                var wf = getWorkFrame();
                var bw = getBasicWindow();
                var ctx = {
                    user: window.GVars.user_id,
                    adminUnit: window.GVars.owner_name || window.GVars.owner_id,
                    moduleId: window.GVars.module_id,
                    windowId: bw ? (bw.GetWindowId ? bw.GetWindowId() : null) : null,
                    windowTitle: getWindowTitle(),
                    locationLabel: getLocationLabel(),
                    menuId: getCurrentMenuId() || null,
                    datawindows: findAllDataWindows(),
                    frameLoaded: !!wf
                };
                if (wf) {
                    try { ctx.windowTitle = wf.document.title || null; } catch (e) {}
                }
                return Promise.resolve(JSON.stringify(ctx));
            },
            timeOutInMs: 5000
        },

        dom_get_required_fields: {
            definition: {
                name: "dom_get_required_fields",
                description: "List required/mandatory columns on every grid in the current AgileAssets window. Use this when the user asks what they must fill in before Save — do NOT guess and do NOT call REST for this.",
                parameters: { type: "object", properties: {} }
            },
            callback: function () {
                var names = findAllDataWindows();
                var grids = [];
                names.forEach(function (n) {
                    var dw = getDataWindowByName(n);
                    if (!dw || !dw.ColumnCount) return;
                    var required = [];
                    var optional = [];
                    var cc = dw.ColumnCount();
                    for (var c = 1; c <= cc; c++) {
                        var name = dw.GetColumnName ? dw.GetColumnName(c) : ("col_" + c);
                        var label = dw.GetColumnLabel ? dw.GetColumnLabel(c) : name;
                        var vis = dw.IsColumnVisible ? dw.IsColumnVisible(c) : true;
                        var req = dw.IsColumnRequired ? !!dw.IsColumnRequired(c) : false;
                        var item = { name: name, label: label, visible: vis };
                        if (req) required.push(item);
                        else if (vis) optional.push({ name: name, label: label });
                    }
                    grids.push({
                        datawindow: n,
                        required: required,
                        visibleOptionalCount: optional.length
                    });
                });
                return Promise.resolve(JSON.stringify({
                    window: getLocationLabel(),
                    hint: "These are DataWindow required flags for Save on this screen (not REST schema).",
                    grids: grids
                }));
            },
            timeOutInMs: 8000
        },

        dom_read_grid: {
            definition: {
                name: "dom_read_grid",
                description: "Read rows and columns from a DataWindow/grid in the current AgileAssets window. Use dom_get_page_context first to discover available datawindow names (e.g. 'dw_wo' for Work Orders, 'dw_loc' for Work Locations, 'dw_labor' for Labor).",
                parameters: {
                    type: "object",
                    properties: {
                        datawindow: { type: "string", description: "Name of the DataWindow object (e.g. 'dw_wo', 'dw_loc', 'dw_labor')" },
                        maxRows: { type: "number", description: "Max rows to return (default 50)" }
                    },
                    required: ["datawindow"]
                }
            },
            callback: function (args) {
                return Promise.resolve(JSON.stringify(readGridData(args.datawindow, args.maxRows || 50)));
            },
            timeOutInMs: 10000
        },

        dom_get_grid_columns: {
            definition: {
                name: "dom_get_grid_columns",
                description: "Get column definitions (name, label, type) for a DataWindow/grid. Helps understand what fields are available.",
                parameters: {
                    type: "object",
                    properties: {
                        datawindow: { type: "string", description: "Name of the DataWindow" }
                    },
                    required: ["datawindow"]
                }
            },
            callback: function (args) {
                var dw = getDataWindowByName(args.datawindow);
                if (!dw) return Promise.resolve(JSON.stringify({ error: "DataWindow not found: " + args.datawindow }));
                var cols = [];
                var cc = dw.ColumnCount();
                for (var c = 1; c <= cc; c++) {
                    var col = {
                        index: c,
                        name: dw.GetColumnName ? dw.GetColumnName(c) : ("col_" + c),
                        label: dw.GetColumnLabel ? dw.GetColumnLabel(c) : ""
                    };
                    if (dw.IsColumnEditable) col.editable = dw.IsColumnEditable(c);
                    if (dw.IsColumnVisible) col.visible = dw.IsColumnVisible(c);
                    cols.push(col);
                }
                return Promise.resolve(JSON.stringify({
                    datawindow: args.datawindow,
                    columnCount: cc,
                    columns: cols
                }));
            },
            timeOutInMs: 5000
        },

        dom_get_current_row: {
            definition: {
                name: "dom_get_current_row",
                description: "Get data from the currently selected/highlighted row in a DataWindow grid.",
                parameters: {
                    type: "object",
                    properties: {
                        datawindow: { type: "string", description: "Name of the DataWindow" }
                    },
                    required: ["datawindow"]
                }
            },
            callback: function (args) {
                var dw = getDataWindowByName(args.datawindow);
                if (!dw) return Promise.resolve(JSON.stringify({ error: "DataWindow not found" }));
                var row = dw.GetRow ? dw.GetRow() : 0;
                if (row <= 0) return Promise.resolve(JSON.stringify({ error: "No row selected", totalRows: dw.RowCount() }));
                var cc = dw.ColumnCount();
                var data = { _row: row };
                for (var c = 1; c <= cc; c++) {
                    var name = dw.GetColumnName ? dw.GetColumnName(c) : ("col_" + c);
                    try { data[name] = dw.GetItem(row, c); } catch (e) { data[name] = null; }
                }
                return Promise.resolve(JSON.stringify({ datawindow: args.datawindow, currentRow: row, totalRows: dw.RowCount(), data: data }));
            },
            timeOutInMs: 5000
        },

        dom_get_menu_items: {
            definition: {
                name: "dom_get_menu_items",
                description: "Get available action menu items for a DataWindow (the 'Actions' dropdown). Tells you what actions like Insert, Delete, Sort, Export are available.",
                parameters: {
                    type: "object",
                    properties: {
                        datawindow: { type: "string", description: "Name of the DataWindow" }
                    },
                    required: ["datawindow"]
                }
            },
            callback: function (args) {
                return Promise.resolve(JSON.stringify(getMenuItems(args.datawindow)));
            },
            timeOutInMs: 5000
        },

        // --- DOM Interaction: Actions ---
        dom_click_action: {
            definition: {
                name: "dom_click_action",
                description: "Execute a menu action on a DataWindow (e.g. 'insert', 'delete', 'insert_like', 'make_daycards', 'edit_dates', 'assign_crew'). Use dom_get_menu_items first to see available actions.",
                parameters: {
                    type: "object",
                    properties: {
                        datawindow: { type: "string", description: "Name of the DataWindow (e.g. 'dw_wo')" },
                        actionId: { type: "string", description: "Menu action ID to execute (e.g. 'insert', 'delete', 'insert_like')" }
                    },
                    required: ["datawindow", "actionId"]
                }
            },
            callback: function (args) {
                var dw = getDataWindowByName(args.datawindow);
                if (!dw) return Promise.resolve(JSON.stringify({ error: "DataWindow not found: " + args.datawindow }));
                var bw = getBasicWindow();
                try {
                    if (bw) bw.SetMenuObject(dw);
                    dw.ActionHandle(args.actionId);
                    return Promise.resolve(JSON.stringify({ success: true, action: args.actionId, datawindow: args.datawindow }));
                } catch (e) {
                    return Promise.resolve(JSON.stringify({ error: e.message, action: args.actionId }));
                }
            },
            timeOutInMs: 15000
        },

        dom_set_field: {
            definition: {
                name: "dom_set_field",
                description: "Set a value in a specific cell (row + column) of a DataWindow grid. Use dom_get_grid_columns to find column names first.",
                parameters: {
                    type: "object",
                    properties: {
                        datawindow: { type: "string", description: "DataWindow name" },
                        row: { type: "number", description: "Row number (1-based). Use 0 for current row." },
                        column: { type: "string", description: "Column name (e.g. 'plan_qty', 'ps_comments')" },
                        value: { type: "string", description: "Value to set" }
                    },
                    required: ["datawindow", "column", "value"]
                }
            },
            callback: function (args) {
                var dw = getDataWindowByName(args.datawindow);
                if (!dw) return Promise.resolve(JSON.stringify({ error: "DataWindow not found" }));
                var row = args.row || (dw.GetRow ? dw.GetRow() : 0);
                if (row <= 0) return Promise.resolve(JSON.stringify({ error: "No row selected and no row specified" }));
                var colIndex = null;
                var cc = dw.ColumnCount();
                for (var c = 1; c <= cc; c++) {
                    if (dw.GetColumnName && dw.GetColumnName(c).toLowerCase() === args.column.toLowerCase()) {
                        colIndex = c;
                        break;
                    }
                }
                if (!colIndex) return Promise.resolve(JSON.stringify({ error: "Column not found: " + args.column }));
                try {
                    dw.SetItem(row, colIndex, args.value);
                    if (dw.ShowRows) dw.ShowRows();
                    return Promise.resolve(JSON.stringify({ success: true, row: row, column: args.column, value: args.value }));
                } catch (e) {
                    return Promise.resolve(JSON.stringify({ error: e.message }));
                }
            },
            timeOutInMs: 10000
        },

        dom_select_row: {
            definition: {
                name: "dom_select_row",
                description: "Select/highlight a specific row in a DataWindow grid.",
                parameters: {
                    type: "object",
                    properties: {
                        datawindow: { type: "string", description: "DataWindow name" },
                        row: { type: "number", description: "Row number to select (1-based)" }
                    },
                    required: ["datawindow", "row"]
                }
            },
            callback: function (args) {
                var dw = getDataWindowByName(args.datawindow);
                if (!dw) return Promise.resolve(JSON.stringify({ error: "DataWindow not found" }));
                if (args.row < 1 || args.row > dw.RowCount())
                    return Promise.resolve(JSON.stringify({ error: "Row " + args.row + " out of range (1-" + dw.RowCount() + ")" }));
                try {
                    dw.SetRow(args.row);
                    if (dw.ScrollToRow) dw.ScrollToRow(args.row);
                    return Promise.resolve(JSON.stringify({ success: true, selectedRow: args.row }));
                } catch (e) {
                    return Promise.resolve(JSON.stringify({ error: e.message }));
                }
            },
            timeOutInMs: 5000
        },

        dom_save: {
            definition: {
                name: "dom_save",
                description: "Save all changes in the current AgileAssets window. Uses basic_window.SaveData() which POSTs XML changes to ControllerServlet (not REST API). Also tries the top-level Save button as fallback.",
                parameters: { type: "object", properties: {} }
            },
            callback: function () {
                var wf = getWorkFrame();
                if (!wf) return Promise.resolve(JSON.stringify({ error: "Work frame not loaded" }));
                try {
                    if (wf.basic_window && wf.basic_window.SaveData) {
                        wf.basic_window.SaveData();
                        return Promise.resolve(JSON.stringify({ success: true, message: "basic_window.SaveData() called" }));
                    }
                    if (wf.basic_window && wf.basic_window.WindowSave) {
                        wf.basic_window.WindowSave();
                        return Promise.resolve(JSON.stringify({ success: true, message: "WindowSave called" }));
                    }
                    var topWin = wf.basic_window ? wf.basic_window.GetTopWin() : window;
                    var saveBtn = topWin.document.getElementById("save_icon") ||
                                  topWin.document.querySelector("[id*='save']");
                    if (saveBtn) {
                        saveBtn.click();
                        return Promise.resolve(JSON.stringify({ success: true, message: "Save button clicked" }));
                    }
                    return Promise.resolve(JSON.stringify({ error: "No save mechanism found" }));
                } catch (e) {
                    return Promise.resolve(JSON.stringify({ error: e.message }));
                }
            },
            timeOutInMs: 15000
        },

        dom_navigate: {
            definition: {
                name: "dom_navigate",
                description: "Open an AgileAssets window by catalog lookup (Oklahoma menu_id URL). Prefer search_windows + open_window. Example: menuPath 'Roadway > Progress > Day Cards' opens 3_wo_daycards.",
                parameters: {
                    type: "object",
                    properties: {
                        menuPath: { type: "string", description: "Window name or path, e.g. 'Day Cards' or 'Roadway > Progress > Day Cards'" }
                    },
                    required: ["menuPath"]
                }
            },
            callback: function (args) {
                return loadWindowCatalog().then(function () {
                    return JSON.stringify(resolveAndOpenWindow({ query: args.menuPath }));
                });
            },
            timeOutInMs: 8000
        },

        dom_insert_row: {
            definition: {
                name: "dom_insert_row",
                description: "Insert a new row into a DataWindow grid. This is the programmatic equivalent of clicking 'Insert' from the Actions menu. For work orders in Day Cards, this will trigger the WO Attributes dialog.",
                parameters: {
                    type: "object",
                    properties: {
                        datawindow: { type: "string", description: "DataWindow name (e.g. 'dw_wo')" }
                    },
                    required: ["datawindow"]
                }
            },
            callback: function (args) {
                var dw = getDataWindowByName(args.datawindow);
                if (!dw) return Promise.resolve(JSON.stringify({ error: "DataWindow not found: " + args.datawindow }));
                try {
                    var newRow = dw.InsertRow(0);
                    return Promise.resolve(JSON.stringify({ success: true, newRow: newRow, totalRows: dw.RowCount() }));
                } catch (e) {
                    return Promise.resolve(JSON.stringify({ error: e.message }));
                }
            },
            timeOutInMs: 15000
        },

        dom_get_dropdown_values: {
            definition: {
                name: "dom_get_dropdown_values",
                description: "Get available dropdown/select values for a column in a DataWindow. Useful for finding valid Project IDs, Asset Types, Activities, Crews, etc.",
                parameters: {
                    type: "object",
                    properties: {
                        datawindow: { type: "string", description: "DataWindow name" },
                        column: { type: "string", description: "Column name to get dropdown values for" }
                    },
                    required: ["datawindow", "column"]
                }
            },
            callback: function (args) {
                var dw = getDataWindowByName(args.datawindow);
                if (!dw) return Promise.resolve(JSON.stringify({ error: "DataWindow not found" }));
                var colIndex = null;
                var cc = dw.ColumnCount();
                for (var c = 1; c <= cc; c++) {
                    if (dw.GetColumnName && dw.GetColumnName(c).toLowerCase() === args.column.toLowerCase()) {
                        colIndex = c;
                        break;
                    }
                }
                if (!colIndex) return Promise.resolve(JSON.stringify({ error: "Column not found: " + args.column }));
                var values = [];
                try {
                    var ddw = dw.GetDddw ? dw.GetDddw(colIndex) : null;
                    if (ddw && ddw.RowCount) {
                        var rc = ddw.RowCount();
                        for (var r = 1; r <= Math.min(rc, 200); r++) {
                            var item = { value: ddw.GetItem(r, 1) };
                            if (ddw.ColumnCount() >= 2) item.display = ddw.GetItem(r, 2);
                            values.push(item);
                        }
                        return Promise.resolve(JSON.stringify({ column: args.column, totalValues: rc, values: values }));
                    }
                    return Promise.resolve(JSON.stringify({ column: args.column, error: "No dropdown data found for this column" }));
                } catch (e) {
                    return Promise.resolve(JSON.stringify({ error: e.message }));
                }
            },
            timeOutInMs: 10000
        },

        dom_interact_dialog: {
            definition: {
                name: "dom_interact_dialog",
                description: "Interact with a currently open dialog/popup window in AgileAssets. Can read its content, select dropdown values, fill fields, or click buttons (OK, Cancel, Back, Next). Use for the WO Attributes selection dialog during work order creation.",
                parameters: {
                    type: "object",
                    properties: {
                        action: { type: "string", description: "Action: 'read' to get dialog state, 'select' to choose a dropdown value, 'fill' to set a text field, 'click' to click a button" },
                        target: { type: "string", description: "For 'select': the dropdown identifier. For 'fill': the field name. For 'click': button text or id (e.g. 'OK', 'Cancel', 'Back', 'Next')" },
                        value: { type: "string", description: "For 'select': the value/text to select. For 'fill': the text to enter" }
                    },
                    required: ["action"]
                }
            },
            callback: function (args) {
                var wf = getWorkFrame();
                if (!wf) return Promise.resolve(JSON.stringify({ error: "Work frame not loaded" }));
                try {
                    var modalFrames = [];
                    var iframes = wf.document.querySelectorAll("iframe");
                    for (var i = 0; i < iframes.length; i++) {
                        try {
                            if (iframes[i].contentWindow && iframes[i].style.display !== "none"
                                && iframes[i].offsetWidth > 0) {
                                modalFrames.push(iframes[i]);
                            }
                        } catch (e) {}
                    }
                    var dialogWin = modalFrames.length > 0
                        ? modalFrames[modalFrames.length - 1].contentWindow : wf;

                    if (args.action === "read") {
                        var dialogInfo = { dialogs: [] };
                        for (var di = 0; di < modalFrames.length; di++) {
                            try {
                                var df = modalFrames[di];
                                var dWin = df.contentWindow;
                                var dDoc = dWin.document;
                                var title = dDoc.title || "";
                                var selects = dDoc.querySelectorAll("select, [class*='selectbox']");
                                var buttons = dDoc.querySelectorAll("button, input[type='button'], [class*='btn']");
                                var texts = dDoc.querySelectorAll("input[type='text'], textarea");
                                var selectInfo = [];
                                for (var si = 0; si < selects.length; si++) {
                                    var sel = selects[si];
                                    var opts = [];
                                    if (sel.options) {
                                        for (var oi = 0; oi < Math.min(sel.options.length, 50); oi++) {
                                            opts.push({ value: sel.options[oi].value, text: sel.options[oi].text });
                                        }
                                    }
                                    selectInfo.push({ id: sel.id, name: sel.name, currentValue: sel.value, options: opts });
                                }
                                var btnInfo = [];
                                for (var bi = 0; bi < buttons.length; bi++) {
                                    btnInfo.push({ text: buttons[bi].textContent.trim(), id: buttons[bi].id });
                                }
                                var allText = dDoc.body ? dDoc.body.innerText.substring(0, 2000) : "";
                                dialogInfo.dialogs.push({
                                    index: di,
                                    title: title,
                                    frameId: df.id,
                                    selects: selectInfo,
                                    buttons: btnInfo,
                                    visibleText: allText
                                });
                            } catch (e) {
                                dialogInfo.dialogs.push({ index: di, error: e.message });
                            }
                        }
                        if (dialogInfo.dialogs.length === 0) {
                            dialogInfo.message = "No modal dialog detected. Checking for WODialog or selectbox objects...";
                            var woDialog = wf.wo_dialog || wf.daycards_wo_dialog;
                            if (woDialog) {
                                dialogInfo.woDialogFound = true;
                                dialogInfo.woDialogSelection = woDialog.selection || {};
                            }
                        }
                        return Promise.resolve(JSON.stringify(dialogInfo));
                    }

                    if (args.action === "click") {
                        var target = (args.target || "").toLowerCase();
                        var allBtns = dialogWin.document.querySelectorAll(
                            "button, input[type='button'], [class*='btn'], [role='button']"
                        );
                        for (var bi2 = 0; bi2 < allBtns.length; bi2++) {
                            var btnText = (allBtns[bi2].textContent || allBtns[bi2].value || "").trim().toLowerCase();
                            var btnId = (allBtns[bi2].id || "").toLowerCase();
                            if (btnText === target || btnId === target || btnText.indexOf(target) >= 0) {
                                allBtns[bi2].click();
                                return Promise.resolve(JSON.stringify({ success: true, clicked: btnText || btnId }));
                            }
                        }
                        var bw2 = dialogWin.basic_window;
                        if (bw2 && target === "ok" && dialogWin.bt_ok) {
                            dialogWin.bt_ok.clicked();
                            return Promise.resolve(JSON.stringify({ success: true, clicked: "bt_ok" }));
                        }
                        if (bw2 && target === "cancel" && dialogWin.bt_cancel) {
                            dialogWin.bt_cancel.clicked();
                            return Promise.resolve(JSON.stringify({ success: true, clicked: "bt_cancel" }));
                        }
                        return Promise.resolve(JSON.stringify({ error: "Button not found: " + args.target }));
                    }

                    if (args.action === "select") {
                        var sbObjs = ["sb_0", "sb_1", "sb_2", "sb_3", "sb_4", "sb_5"];
                        var targetIdx = parseInt(args.target);
                        if (!isNaN(targetIdx) && dialogWin[sbObjs[targetIdx]]) {
                            var sb = dialogWin[sbObjs[targetIdx]];
                            var searchVal = (args.value || "").toLowerCase();
                            if (sb.GetDddw) {
                                var ddw = sb.GetDddw();
                                if (ddw && ddw.RowCount) {
                                    for (var dr = 1; dr <= ddw.RowCount(); dr++) {
                                        var displayText = ddw.GetItem(dr, 2) || ddw.GetItem(dr, 1) || "";
                                        if (String(displayText).toLowerCase().indexOf(searchVal) >= 0) {
                                            sb.SetItem(1, 1, ddw.GetItem(dr, 1));
                                            if (sb.ShowRows) sb.ShowRows();
                                            return Promise.resolve(JSON.stringify({
                                                success: true, selected: displayText, value: ddw.GetItem(dr, 1), selectbox: sbObjs[targetIdx]
                                            }));
                                        }
                                    }
                                }
                            }
                            return Promise.resolve(JSON.stringify({ error: "Value not found in dropdown: " + args.value }));
                        }
                        var allSelects = dialogWin.document.querySelectorAll("select");
                        for (var asi = 0; asi < allSelects.length; asi++) {
                            var asel = allSelects[asi];
                            if (asel.id === args.target || asel.name === args.target) {
                                for (var oi2 = 0; oi2 < asel.options.length; oi2++) {
                                    if (asel.options[oi2].text.toLowerCase().indexOf(args.value.toLowerCase()) >= 0) {
                                        asel.selectedIndex = oi2;
                                        asel.dispatchEvent(new Event("change", { bubbles: true }));
                                        return Promise.resolve(JSON.stringify({ success: true, selected: asel.options[oi2].text }));
                                    }
                                }
                            }
                        }
                        return Promise.resolve(JSON.stringify({ error: "Dropdown not found: " + args.target }));
                    }

                    if (args.action === "fill") {
                        var inputs = dialogWin.document.querySelectorAll("input[type='text'], textarea, input:not([type])");
                        for (var fi = 0; fi < inputs.length; fi++) {
                            if (inputs[fi].id === args.target || inputs[fi].name === args.target) {
                                inputs[fi].value = args.value;
                                inputs[fi].dispatchEvent(new Event("input", { bubbles: true }));
                                inputs[fi].dispatchEvent(new Event("change", { bubbles: true }));
                                return Promise.resolve(JSON.stringify({ success: true, filled: args.target, value: args.value }));
                            }
                        }
                        return Promise.resolve(JSON.stringify({ error: "Input field not found: " + args.target }));
                    }

                    return Promise.resolve(JSON.stringify({ error: "Unknown action: " + args.action }));
                } catch (e) {
                    return Promise.resolve(JSON.stringify({ error: e.message }));
                }
            },
            timeOutInMs: 15000
        },

        // --- Workflow: Create Work Order in Day Cards ---
        create_work_order_daycard: {
            definition: {
                name: "create_work_order_daycard",
                description: "High-level workflow to create a new Work Order in the Day Cards window. The main WO grid is 'dw_1' (NOT 'dw_wo'). Insert triggers OpenModalDialog('major_attr_ie') which is the WO Attributes wizard. Day card grids are dw_labor_dc, dw_equipment_dc, dw_material_dc, dw_costs. Save uses basic_window.SaveData() not REST API. Follows ODOT workflow: select Project > Asset Type > Activity > Inventory Element.",
                parameters: {
                    type: "object",
                    properties: {
                        projectName: { type: "string", description: "Project name to select (e.g. 'Routine Maintenance', 'Overhead Activities', 'Material Mixing')" },
                        assetType: { type: "string", description: "Asset type name (e.g. 'Bridges', 'Control Sections')" },
                        activityName: { type: "string", description: "Activity name or partial match" },
                        inventoryElement: { type: "string", description: "Inventory element name or partial match (optional for Overhead)" },
                        planQuantity: { type: "string", description: "Plan quantity value (required to save)" },
                        psComments: { type: "string", description: "PS Comments (mandatory)" },
                        workCrew: { type: "string", description: "Work crew name (optional)" }
                    },
                    required: ["projectName", "activityName", "planQuantity", "psComments"]
                }
            },
            callback: function (args) {
                var wf = getWorkFrame();
                if (!wf) return Promise.resolve(JSON.stringify({ error: "Work frame not loaded" }));

                var steps = [];
                var dw1 = getDataWindowByName("dw_1");
                if (dw1) {
                    steps.push("Step 1: Found dw_1 (Work Orders grid) with " + dw1.RowCount() + " rows.");
                    steps.push("Step 2: Triggering Insert on dw_1...");
                    try {
                        var newRow = dw1.InsertRow(0);
                        if (newRow > 0) {
                            steps.push("New row " + newRow + " inserted in dw_1.");
                            var bw = getBasicWindow();
                            if (bw) {
                                wf.InStructure = wf.InStructure || {};
                                wf.InStructure.cur_row = newRow;
                                wf.InStructure.setPreviousValues = false;
                                var maxId = bw.GetMaxId ? bw.GetMaxId("dw_1", "WORK_ORDER_ID") : null;
                                if (maxId) dw1.SetItem(newRow, "WORK_ORDER_ID", maxId);
                                steps.push("Step 3: Opening major_attr_ie dialog (WO Attributes wizard)...");
                                bw.OpenModalDialog("major_attr_ie");
                                steps.push("WO Attributes dialog opened. Use dom_interact_dialog to select Project, Asset Type, Activity, Inventory Element.");
                            } else {
                                steps.push("WARNING: basic_window not found. Try dom_click_action(dw_1, 'insert') instead.");
                            }
                        }
                    } catch (e) {
                        steps.push("Error during insert: " + e.message);
                        steps.push("Fallback: Try dom_click_action with datawindow='dw_1' and actionId='insert'");
                    }
                } else {
                    steps.push("ERROR: dw_1 DataWindow not found. Make sure you are on the Day Cards window (Roadway > Progress > Day Cards).");
                    steps.push("Available DataWindows: " + findAllDataWindows().join(", "));
                    var woDialog = wf.wo_dialog || wf.daycards_wo_dialog;
                    if (woDialog) {
                        steps.push("Found WO Dialog object (Kendo variant). State: " + JSON.stringify(woDialog.selection || {}));
                    }
                }

                return Promise.resolve(JSON.stringify({
                    workflow: "create_work_order_daycard",
                    parameters: args,
                    steps: steps,
                    instructions: [
                        "1. Ensure Day Cards window is open: Roadway > Progress > Day Cards",
                        "2. Use dom_get_page_context to verify dw_1 exists (main WO grid). Day card grids: dw_labor_dc, dw_equipment_dc, dw_material_dc, dw_costs",
                        "3. Call dom_click_action(datawindow='dw_1', actionId='insert') to insert row and open major_attr_ie dialog",
                        "4. Use dom_interact_dialog(action='read') to see WO Attributes dialog state",
                        "5. Use dom_interact_dialog(action='select', target='0', value='<project>') for Project (sb_0)",
                        "6. Click OK/Next, select Asset Type (sb_1), Activity (sb_2), Inv Element (sb_3)",
                        "7. After dialog closes, use dom_set_field on dw_1 to fill: plan_qty, ps_comments, work_crew",
                        "8. Use dom_save to persist (calls basic_window.SaveData which POSTs XML to ControllerServlet)"
                    ]
                }));
            },
            timeOutInMs: 30000
        },

        // --- MCP health ---
        health_check: {
            definition: {
                name: "health_check",
                description: "Health check for the MCP server. Returns status of REST API and Oracle DB connectivity.",
                parameters: { type: "object", properties: {} }
            },
            callback: function () {
                return mcpToolCall("health_check", {});
            },
            timeOutInMs: 15000
        },

        // --- Generic ---
        list_api_endpoints: {
            definition: {
                name: "list_api_endpoints",
                description: "Search the AgileAssets REST V2 OpenAPI catalog (~205 operations). Returns matching method+path+tag. Then call agile_assets_api to invoke one.",
                parameters: {
                    type: "object",
                    properties: {
                        query: { type: "string", description: "Keyword to match against path, tag, or summary (e.g. 'workorder', 'labor', 'mwm')" },
                        tag:   { type: "string", description: "Optional tag filter, e.g. 'Work Orders Resource'" },
                        limit: { type: "number", description: "Max results (default 30)" }
                    }
                }
            },
            callback: function (args) {
                var q = String((args && args.query) || "").toLowerCase();
                var tag = String((args && args.tag) || "").toLowerCase();
                var limit = (args && args.limit) || 30;
                return loadApiCatalog().then(function (cat) {
                    var hits = cat.filter(function (e) {
                        if (tag && String(e.tag).toLowerCase().indexOf(tag) < 0) return false;
                        if (!q) return true;
                        return (e.path + " " + e.tag + " " + e.summary + " " + e.operationId).toLowerCase().indexOf(q) >= 0;
                    }).slice(0, limit);
                    return JSON.stringify({ totalInSpec: cat.length, shown: hits.length, endpoints: hits });
                }).catch(function (e) {
                    return JSON.stringify({ error: "Could not load OpenAPI: " + e.message });
                });
            },
            timeOutInMs: 20000
        },

        describe_api_endpoint: {
            definition: {
                name: "describe_api_endpoint",
                description: "Get parameters and request-body fields for one REST V2 path from OpenAPI. path like '/workorders/{id}'.",
                parameters: {
                    type: "object",
                    properties: {
                        method: { type: "string", description: "GET, POST, PUT, or DELETE" },
                        path:   { type: "string", description: "OpenAPI path, e.g. '/workorders/{id}'" }
                    },
                    required: ["method", "path"]
                }
            },
            callback: function (args) {
                var method = String(args.method || "GET").toLowerCase();
                var path = args.path;
                return loadApiCatalog().then(function () {
                    var ops = API_SPEC && API_SPEC.paths && API_SPEC.paths[path];
                    if (!ops || !ops[method]) {
                        var keys = API_SPEC && API_SPEC.paths ? Object.keys(API_SPEC.paths) : [];
                        var close = keys.filter(function (k) { return k.indexOf(path.replace(/^\//, "")) >= 0; }).slice(0, 8);
                        return JSON.stringify({ error: "Path/method not found", closePaths: close });
                    }
                    var op = ops[method];
                    return JSON.stringify({
                        method: method.toUpperCase(),
                        path: path,
                        summary: op.summary || "",
                        description: (op.description || "").slice(0, 1500),
                        tags: op.tags || [],
                        parameters: op.parameters || [],
                        requestBody: op.requestBody || null,
                        operationId: op.operationId || ""
                    });
                }).catch(function (e) {
                    return JSON.stringify({ error: e.message });
                });
            },
            timeOutInMs: 20000
        },

        agile_assets_api: {
            definition: {
                name: "agile_assets_api",
                description: "Call any AgileAssets REST V2 endpoint using the current user's TID token. endpoint is relative to /rest/v2/ (e.g. 'workorders', 'mwm/labor/shortlist'). Discover paths with list_api_endpoints first. Writes (POST/PUT/DELETE) should be confirmed with the user.",
                parameters: {
                    type: "object",
                    properties: {
                        method:   { type: "string", description: "HTTP method: GET, POST, PUT, DELETE" },
                        endpoint: { type: "string", description: "Path relative to /rest/v2/, e.g. 'workorders/123' or 'mwm/labor'" },
                        body:     { type: "string", description: "POST/PUT body as a JSON string, e.g. '{\"name\":\"x\"}'. Omit for GET." },
                        params:   { type: "string", description: "Query parameters as a JSON string, e.g. '{\"limit\":20}'. Omit if none." }
                    },
                    required: ["method", "endpoint"]
                }
            },
            callback: function (args) {
                return apiRequest(args.method, args.endpoint, args.params, args.body);
            },
            timeOutInMs: 30000
        },

        search_windows: {
            definition: {
                name: "search_windows",
                description: "Search the Oklahoma AgileAssets window catalog (SYSTEM_MENU). Returns menu_id, label, and path. Use this BEFORE opening a window. Then call open_window with the chosen menu_id. Example: 'day cards' → Roadway 3_wo_daycards, Facilities 7_wo_daycards.",
                parameters: {
                    type: "object",
                    properties: {
                        query: { type: "string", description: "Window name, path fragment, or menu_id (e.g. 'day cards', 'work order', 'system log')" },
                        limit: { type: "number", description: "Max matches (default 12)" }
                    },
                    required: ["query"]
                }
            },
            callback: function (args) {
                return loadWindowCatalog().then(function () {
                    var matches = searchWindows(args.query, args.limit || 12);
                    return JSON.stringify({
                        query: args.query,
                        count: matches.length,
                        catalogSize: WINDOW_CATALOG.length,
                        currentMenuId: getCurrentMenuId() || null,
                        matches: matches
                    });
                });
            },
            timeOutInMs: 8000
        },

        open_window: {
            definition: {
                name: "open_window",
                description: "Open an AgileAssets window in this tab via w_main.jsp?AA_SID=&menu_id= (same as the Helper extension). Prefer passing menu_id from search_windows. If only a name is known, pass query and this tool will pick a high-confidence match or return choices. Reloads the shell; Work Assist stays open.",
                parameters: {
                    type: "object",
                    properties: {
                        menu_id: { type: "string", description: "Exact SYSTEM_MENU id, e.g. '3_wo_daycards'" },
                        query: { type: "string", description: "If menu_id unknown, window name or path to resolve" }
                    }
                }
            },
            callback: function (args) {
                return loadWindowCatalog().then(function () {
                    return JSON.stringify(resolveAndOpenWindow(args || {}));
                });
            },
            timeOutInMs: 8000
        },

        get_window_identity: {
            definition: {
                name: "get_window_identity",
                description: "Identify the current AgileAssets window: title, location label, menu_id, and catalog path. Use this when the user says 'this screen' or before Save/required-fields questions."
            },
            callback: function () {
                return loadWindowCatalog().then(function () {
                    var menuId = getCurrentMenuId() || "";
                    var matches = WINDOW_CATALOG.filter(function (w) { return w.id === menuId; });
                    return JSON.stringify({
                        title: getWindowTitle(),
                        locationLabel: getLocationLabel(),
                        menu_id: menuId || null,
                        paths: matches.map(function (w) { return w.path; }),
                        label: matches[0] ? matches[0].label : null
                    });
                });
            },
            timeOutInMs: 5000
        }
    };

    // -----------------------------------------------------------------------
    // onBeforeRun configuration for the Trimble iframe SDK
    // -----------------------------------------------------------------------

    // The Trimble iframe SDK validates every tool definition on the CHILD side
    // with a Zod schema where `parameters.required` (and `type`/`properties`) is
    // MANDATORY whenever `parameters` is present. A single non-conforming tool
    // makes the child reject the ENTIRE OnBeforeRunResponse, so it discards it and
    // the run falls back to the 30s onBeforeRun timeout with no tools/context.
    // Normalize here so partially-specified tool schemas never break the handoff.
    function ensureToolSchemas(tools) {
        if (!tools) return;
        Object.keys(tools).forEach(function (id) {
            var entry = tools[id];
            var def = entry && entry.definition;
            if (!def || !def.parameters) return;
            var p = def.parameters;
            if (typeof p.type !== "string") p.type = "object";
            if (!p.properties || typeof p.properties !== "object") p.properties = {};
            delete p.additionalProperties;
            Object.keys(p.properties).forEach(function (k) {
                if (p.properties[k] && typeof p.properties[k] === "object") {
                    delete p.properties[k].additionalProperties;
                }
            });
            var keys = Object.keys(p.properties);
            // Empty `{type:object, properties:{}, required:[]}` 422s the stage
            // models API. No-arg tools must omit `parameters` entirely (SDK Zod
            // allows it). If parameters stay, `required` is mandatory.
            if (keys.length === 0) {
                delete def.parameters;
                return;
            }
            if (!Array.isArray(p.required)) p.required = [];
            p.required = p.required.filter(function (k) { return keys.indexOf(k) >= 0; });
        });
    }

    // Studio already exposes MCP/REST tools on the agent. Re-sending the same
    // names from the iframe (run_sql, list_work_orders, …) makes the stage
    // run API return 422 Unprocessable Content. Only attach embed-unique tools.
    var HOST_RUNTIME_TOOL_IDS = [
        "dom_get_page_context",
        "dom_get_required_fields",
        "dom_read_grid",
        "dom_get_grid_columns",
        "dom_get_current_row",
        "dom_get_menu_items",
        "dom_click_action",
        "dom_set_field",
        "dom_select_row",
        "dom_save",
        "dom_navigate",
        "dom_insert_row",
        "dom_get_dropdown_values",
        "dom_interact_dialog",
        "create_work_order_daycard",
        "list_api_endpoints",
        "describe_api_endpoint",
        "agile_assets_api",
        "search_windows",
        "open_window",
        "get_window_identity"
    ];

    function pickRuntimeTools() {
        var out = {};
        HOST_RUNTIME_TOOL_IDS.forEach(function (id) {
            if (LOCAL_TOOLS[id]) out[id] = LOCAL_TOOLS[id];
        });
        return out;
    }

    function buildOnBeforeRunConfig() {
        var runtime = pickRuntimeTools();
        var domToolNames = HOST_RUNTIME_TOOL_IDS.filter(function (id) {
            return id.indexOf("dom_") === 0 || id === "create_work_order_daycard";
        }).join(", ");
        var apiToolNames = "list_api_endpoints, describe_api_endpoint, agile_assets_api";

        ensureToolSchemas(runtime);

        // Agent runs API: body.context max 10 items (HTTP 422 if longer).
        var g = window.GVars || {};
        var context = [
            { description: "Current window", value: getLocationLabel() + (getCurrentMenuId() ? " menu_id=" + getCurrentMenuId() : "") + ". Use get_window_identity if unsure." },
            { description: "User / admin unit", value: (g.user_id || "unknown") + " / " + (g.owner_name || "") + " (" + String(g.owner_id || "") + ")" },
            { description: "Environment", value: String(g.customer_project_id || "") + " module=" + String(g.module_id || "") + " root=" + (g.application_root || "") },
            { description: "Open a window", value: "Call search_windows then open_window with menu_id (w_main.jsp?AA_SID=&menu_id=). Do not click the menu tree. Roadway Day Cards = 3_wo_daycards. Catalog size " + WINDOW_CATALOG.length + "." },
            { description: "REST V2", value: "Search with list_api_endpoints, inspect with describe_api_endpoint, call with agile_assets_api (user TID token). Do not invent paths. Writes need user confirmation. Tools: " + apiToolNames },
            { description: "Save / required fields", value: "For 'what is required before Save' call dom_get_required_fields (this screen's DataWindow flags). Do not use REST for that." },
            { description: "DOM tools", value: "Call dom_get_page_context first. Then: " + domToolNames + ". Day Cards: dw_1 = Work Orders, dw_labor_dc, dw_equipment_dc, dw_material_dc, dw_costs, dw_loc." },
            { description: "Day Cards WO create", value: "Insert on dw_1 opens major_attr_ie. Select Project, Asset Type, Activity, Inventory Element. Then set plan_qty and ps_comments on dw_1 and dom_save (SaveData XML, not REST)." }
        ].slice(0, 10);
        debugLog("onBeforeRun tools=" + Object.keys(runtime).length + " context=" + context.length);

        return {
            tools: {
                runTime: runtime,
                global: {}
            },
            runContext: {
                context: context
            }
        };
    }

    // -----------------------------------------------------------------------
    // Chat UI configuration for the Trimble iframe SDK
    // -----------------------------------------------------------------------

    function buildChatConfig() {
        var sdk = window.TrimbleAgenticSDK;
        // ContentVariants.Chat (numeric enum = 0) — show the chat conversation,
        // not the agent-selection cards. Fall back to 0 if the SDK isn't loaded.
        var chatContentVariant = (sdk && sdk.ContentVariants && typeof sdk.ContentVariants.Chat !== "undefined")
            ? sdk.ContentVariants.Chat
            : 0;
        // "narrow" is the SDK variant optimized for sidebar/panel embedding.
        var uiVariant = (sdk && sdk.ChatUiVariants && sdk.ChatUiVariants.Narrow)
            ? sdk.ChatUiVariants.Narrow
            : "narrow";
        var cfg = {
            environment: ENV,
            agentId: AGENT_ID,
            uiConfig: {
                theme: THEME,
                variant: uiVariant,
                contentVariant: chatContentVariant,
                chatInput: {
                    buttons: [],
                    hideModelSelection: false
                }
            },
            localization: {}
        };
        var threadId = taGet(TA_THREAD);
        if (threadId) cfg.threadId = threadId;
        return cfg;
    }

    // -----------------------------------------------------------------------
    // DOM – Build the right sidebar panel
    // -----------------------------------------------------------------------

    function buildUI() {
        // FAB button – bottom right
        var fab = document.createElement("button");
        fab.className = "ta-fab";
        fab.title = "Work Assist";
        fab.innerHTML = '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.2L4 17.2V4h16v12z"/><path d="M7 9h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2z"/></svg>';

        // Floating panel
        var panel = document.createElement("div");
        panel.className = "ta-panel";
        panel.innerHTML =
            '<div class="ta-panel__header">' +
                '<div class="ta-panel__where" id="ta-where" title="Current AgileAssets window">No window open</div>' +
                '<div class="ta-panel__header-actions">' +
                    '<button class="ta-panel__icon-btn ta-panel__copy-jira" title="Copy window + build for Jira" aria-label="Copy bug context for Jira">' +
                        '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>' +
                    '</button>' +
                    '<button class="ta-panel__icon-btn ta-panel__view-log" title="View ams-web.log" aria-label="View live application log">' +
                        '<svg viewBox="0 0 24 24"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8M8 9h2"/></svg>' +
                    '</button>' +
                    '<button class="ta-panel__icon-btn ta-panel__expand" title="Expand" aria-label="Expand Work Assist">' +
                        '<svg viewBox="0 0 24 24"><path d="M9 3H5a2 2 0 0 0-2 2v4m0 6v4a2 2 0 0 0 2 2h4m6-18h4a2 2 0 0 1 2 2v4m0 6v4a2 2 0 0 1-2 2h-4"/></svg>' +
                    '</button>' +
                    '<button class="ta-panel__icon-btn ta-panel__restore" title="Back to docked" aria-label="Restore docked size">' +
                        '<svg viewBox="0 0 24 24"><path d="M8 3v4a1 1 0 0 1-1 1H3m18 0h-4a1 1 0 0 1-1-1V3M3 16h4a1 1 0 0 1 1 1v4m8 0v-4a1 1 0 0 1 1-1h4"/></svg>' +
                    '</button>' +
                    '<button class="ta-panel__close ta-panel__icon-btn" title="Close" aria-label="Close Work Assist">' +
                        '<svg viewBox="0 0 24 24"><path d="M18 6 6 18M6 6l12 12"/></svg>' +
                    '</button>' +
                '</div>' +
            '</div>' +
            '<div class="ta-panel__finder">' +
                '<input class="ta-panel__finder-input" id="ta-win-search" type="search" placeholder="Open a window…" autocomplete="off" spellcheck="false" />' +
                '<div class="ta-panel__finder-results" id="ta-win-results" hidden></div>' +
            '</div>' +
            '<div class="ta-panel__loading" id="ta-loading">' +
                '<div class="ta-spinner"></div>' +
                '<span>Loading Work Assist...</span>' +
            '</div>' +
            '<div class="ta-panel__error" id="ta-error">' +
                '<svg viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z"/></svg>' +
                '<span id="ta-error-msg">Could not connect to Work Assist.<br>The service may be temporarily unavailable.</span>' +
                '<button class="ta-panel__error-retry" id="ta-retry">Try Again</button>' +
            '</div>' +
            '<iframe class="ta-panel__iframe ta-hidden" id="ta-chat-iframe" allow="clipboard-write"></iframe>' +
            '<div class="ta-panel__log" id="ta-log" hidden>' +
                '<div class="ta-panel__log-bar">' +
                    '<span>ams-web.log (last ~250 KB, not a file download)</span>' +
                    '<button type="button" class="ta-panel__icon-btn" id="ta-log-refresh" title="Refresh">↻</button>' +
                    '<button type="button" class="ta-panel__icon-btn" id="ta-log-close" title="Close log">×</button>' +
                '</div>' +
                '<pre class="ta-panel__log-body" id="ta-log-body">Loading…</pre>' +
            '</div>' +
            '<div class="ta-panel__status">' +
                '<span class="ta-panel__status-dot"></span>' +
                '<span>Connected as ' + (window.GVars.user_id || 'unknown') + '</span>' +
            '</div>';

        document.body.appendChild(panel);
        document.body.appendChild(fab);

        var isOpen = false;
        var locTimer = null;
        var finderSelected = -1;
        var finderMatches = [];
        var FAB_CHAT = '<svg viewBox="0 0 24 24"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.2L4 17.2V4h16v12z"/><path d="M7 9h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2z"/></svg>';
        var FAB_CLOSE = '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
        var finderInput = document.getElementById("ta-win-search");
        var finderResults = document.getElementById("ta-win-results");
        var isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform || "");

        function refreshChrome() {
            var label = getLocationLabel();
            var mid = getCurrentMenuId();
            var where = document.getElementById("ta-where");
            if (!where) return;
            var shown = mid ? (label + " · " + mid) : label;
            if (where.textContent !== shown) {
                where.textContent = shown;
                where.title = mid
                    ? ("Current window: " + label + " (menu_id=" + mid + ")")
                    : ("Current window: " + label);
            }
        }

        function hideFinderResults() {
            finderSelected = -1;
            finderMatches = [];
            if (finderResults) {
                finderResults.innerHTML = "";
                finderResults.hidden = true;
            }
        }

        function renderFinderResults() {
            if (!finderResults) return;
            if (!finderMatches.length) {
                finderResults.innerHTML = '<div class="ta-panel__finder-empty">No matching windows</div>';
                finderResults.hidden = false;
                return;
            }
            var html = "";
            for (var i = 0; i < finderMatches.length; i++) {
                var m = finderMatches[i];
                html += '<button type="button" class="ta-panel__finder-item' +
                    (i === finderSelected ? " is-active" : "") +
                    '" data-idx="' + i + '" data-id="' + taEsc(m.id) + '">' +
                    '<span class="ta-panel__finder-label">' + taEsc(m.label) + '</span>' +
                    '<span class="ta-panel__finder-path">' + taEsc(m.path) + '</span>' +
                    '</button>';
            }
            html += '<div class="ta-panel__finder-hint"><kbd>↵</kbd> open ' +
                '<kbd>↑↓</kbd> move ' +
                '<kbd>' + (isMac ? "⌘" : "Ctrl") + '+↵</kbd> new session ' +
                '<kbd>esc</kbd> close</div>';
            finderResults.innerHTML = html;
            finderResults.hidden = false;
            var active = finderResults.querySelector(".is-active");
            if (active && active.scrollIntoView) {
                active.scrollIntoView({ block: "nearest" });
            }
        }

        function runFinderSearch() {
            var q = finderInput ? finderInput.value : "";
            if (!String(q).trim()) {
                hideFinderResults();
                return;
            }
            loadWindowCatalog().then(function () {
                if (!finderInput || taNorm(finderInput.value) !== taNorm(q)) return;
                finderMatches = searchWindows(q, 12);
                finderSelected = finderMatches.length ? 0 : -1;
                renderFinderResults();
            });
        }

        function openFinderMatch(idx, newTab) {
            var item = finderMatches[idx];
            if (!item) return;
            navigateToMenuId(item.id, !!newTab);
        }

        if (finderInput) {
            finderInput.addEventListener("input", runFinderSearch);
            finderInput.addEventListener("focus", function () {
                if (String(finderInput.value).trim()) runFinderSearch();
            });
            finderInput.addEventListener("keydown", function (e) {
                if (e.key === "Escape") {
                    e.preventDefault();
                    finderInput.value = "";
                    hideFinderResults();
                    finderInput.blur();
                    return;
                }
                if (e.key === "ArrowDown") {
                    e.preventDefault();
                    if (!finderMatches.length) return;
                    finderSelected = (finderSelected + 1) % finderMatches.length;
                    renderFinderResults();
                    return;
                }
                if (e.key === "ArrowUp") {
                    e.preventDefault();
                    if (!finderMatches.length) return;
                    finderSelected = (finderSelected - 1 + finderMatches.length) % finderMatches.length;
                    renderFinderResults();
                    return;
                }
                if (e.key === "Enter" && finderSelected >= 0) {
                    e.preventDefault();
                    openFinderMatch(finderSelected, e.metaKey || e.ctrlKey);
                }
            });
        }
        if (finderResults) {
            finderResults.addEventListener("mousedown", function (e) {
                var btn = e.target.closest ? e.target.closest(".ta-panel__finder-item") : null;
                if (!btn) return;
                e.preventDefault();
                var idx = parseInt(btn.getAttribute("data-idx"), 10);
                openFinderMatch(idx, e.metaKey || e.ctrlKey);
            });
        }
        document.addEventListener("keydown", function (e) {
            if (!isOpen) return;
            var mod = isMac ? e.metaKey : e.ctrlKey;
            if (mod && (e.key === "k" || e.key === "K") && finderInput) {
                e.preventDefault();
                finderInput.focus();
                finderInput.select();
            }
        });

        function setOpen(open) {
            isOpen = open;
            taSet(TA_OPEN, open ? "1" : "0");
            if (open) {
                panel.classList.add("ta-panel--open");
                if (taGet(TA_EXPANDED) === "1") panel.classList.add("ta-panel--expanded");
                fab.classList.add("ta-fab--close");
                fab.innerHTML = FAB_CLOSE;
                fab.title = "Close Work Assist";
                refreshChrome();
                loadApiCatalog().catch(function () {});
                if (locTimer) clearInterval(locTimer);
                locTimer = setInterval(refreshChrome, 2500);
                initIframe();
            } else {
                panel.classList.remove("ta-panel--open");
                panel.classList.remove("ta-panel--expanded");
                fab.classList.remove("ta-fab--close");
                fab.innerHTML = FAB_CHAT;
                fab.title = "Work Assist";
                if (locTimer) { clearInterval(locTimer); locTimer = null; }
            }
        }

        function setExpanded(expanded) {
            taSet(TA_EXPANDED, expanded ? "1" : "0");
            if (expanded) panel.classList.add("ta-panel--expanded");
            else panel.classList.remove("ta-panel--expanded");
        }

        document.getElementById("ta-retry").addEventListener("click", function () {
            iframeInitialized = false;
            initIframe();
        });

        fab.addEventListener("click", function () {
            setOpen(!isOpen);
        });

        panel.querySelector(".ta-panel__expand").addEventListener("click", function () {
            setExpanded(true);
        });
        panel.querySelector(".ta-panel__restore").addEventListener("click", function () {
            setExpanded(false);
        });
        panel.querySelector(".ta-panel__close").addEventListener("click", function () {
            setOpen(false);
        });

        var copyBtn = panel.querySelector(".ta-panel__copy-jira");
        var logBtn = panel.querySelector(".ta-panel__view-log");
        var logPanel = document.getElementById("ta-log");
        var logBody = document.getElementById("ta-log-body");

        function flashCopy(ok) {
            if (!copyBtn) return;
            copyBtn.title = ok ? "Copied for Jira" : "Copy failed";
            copyBtn.classList.toggle("is-ok", !!ok);
            setTimeout(function () {
                copyBtn.title = "Copy window + build for Jira";
                copyBtn.classList.remove("is-ok");
            }, 1600);
        }

        if (copyBtn) {
            copyBtn.addEventListener("click", function () {
                loadWindowCatalog().then(fetchBuildInfo).then(function (build) {
                    var text = buildJiraSnippet(build);
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        return navigator.clipboard.writeText(text);
                    }
                    var ta = document.createElement("textarea");
                    ta.value = text;
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand("copy");
                    document.body.removeChild(ta);
                }).then(function () { flashCopy(true); }).catch(function () { flashCopy(false); });
            });
        }

        function showLogOverlay(text) {
            if (!logPanel || !logBody) return;
            logBody.textContent = text || "(empty)";
            logPanel.hidden = false;
        }

        function hideLogOverlay() {
            if (logPanel) logPanel.hidden = true;
        }

        function loadLiveLog() {
            if (logBody) logBody.textContent = "Loading ams-web.log…";
            if (logPanel) logPanel.hidden = false;
            fetchAmsWebLog().then(function (text) {
                taSet(TA_SHOW_LOG, null);
                showLogOverlay(text);
            }).catch(function (err) {
                if (String(err && err.message) === "not-on-logs") {
                    taSet(TA_SHOW_LOG, "1");
                    if (logBody) {
                        logBody.textContent = "Opening System > Tools > Logs, then loading the tail of ams-web.log in this panel (no file download)…";
                    }
                    navigateToMenuId("system_log");
                    return;
                }
                showLogOverlay("Could not load log: " + (err && err.message ? err.message : err));
            });
        }

        function waitForLogsWindowThenLoad() {
            var tries = 0;
            function tick() {
                tries += 1;
                var wf = getWorkFrame();
                if (wf && wf.sc_sl && wf.CHTTPParam && wf.basic_window) {
                    loadLiveLog();
                    return;
                }
                if (tries < 40) setTimeout(tick, 400);
                else showLogOverlay("System Logs window did not initialize. Open System > Tools > Logs and try again.");
            }
            tick();
        }

        if (logBtn) logBtn.addEventListener("click", loadLiveLog);
        var logClose = document.getElementById("ta-log-close");
        var logRefresh = document.getElementById("ta-log-refresh");
        if (logClose) logClose.addEventListener("click", hideLogOverlay);
        if (logRefresh) logRefresh.addEventListener("click", loadLiveLog);

        // Restore after w_main.jsp reload (menu / "take me to …" navigation).
        if (taGet(TA_OPEN) === "1") {
            setOpen(true);
            if (taGet(TA_EXPANDED) === "1") setExpanded(true);
        }
        if (taGet(TA_SHOW_LOG) === "1") {
            if (taGet(TA_OPEN) !== "1") setOpen(true);
            waitForLogsWindowThenLoad();
        }
    }

    // -----------------------------------------------------------------------
    // Iframe initialization – SDK path or direct embed
    // -----------------------------------------------------------------------

    var iframeInitialized = false;

    function showLoading() {
        var l = document.getElementById("ta-loading");
        var e = document.getElementById("ta-error");
        var f = document.getElementById("ta-chat-iframe");
        if (l) l.classList.remove("ta-hidden");
        if (e) e.classList.remove("ta-visible");
        if (f) f.classList.add("ta-hidden");
    }

    function showIframe() {
        var l = document.getElementById("ta-loading");
        var e = document.getElementById("ta-error");
        var f = document.getElementById("ta-chat-iframe");
        if (l) l.classList.add("ta-hidden");
        if (e) e.classList.remove("ta-visible");
        if (f) f.classList.remove("ta-hidden");
    }

    function showError(messageHtml) {
        var l = document.getElementById("ta-loading");
        var e = document.getElementById("ta-error");
        var f = document.getElementById("ta-chat-iframe");
        var msg = document.getElementById("ta-error-msg");
        if (l) l.classList.add("ta-hidden");
        if (e) e.classList.add("ta-visible");
        if (f) f.classList.add("ta-hidden");
        if (msg && messageHtml) msg.innerHTML = messageHtml;
    }

    function hasTidToken() {
        var token = window.GVars && window.GVars.access_token;
        return !!(token && String(token).trim() && String(token) !== "null" && String(token) !== "undefined");
    }

    function initIframe() {
        if (iframeInitialized) return;
        iframeInitialized = true;

        var iframe = document.getElementById("ta-chat-iframe");
        if (!iframe) return;

        showLoading();

        // Trimble Assist requires a Trimble Identity (TID) access token.
        // Classic username/password login (w_login.jsp) does not set one —
        // the SPA shell loads dark/blank while loginWithRedirect fails in the iframe.
        if (!hasTidToken()) {
            var authType = (window.GVars && window.GVars.auth_type) || "unknown";
            var ssoUrl = (window.GVars && window.GVars.application_root
                ? window.GVars.application_root.replace(/\/$/, "")
                : window.location.origin + window.location.pathname.replace(/\/Kernel.*/, "")) +
                "/Kernel/w_sso_user.jsp";
            console.warn("[WorkAssist] No TID access_token (auth_type=" + authType + "). Use TID SSO login.");
            showError(
                "Work Assist needs a <b>Trimble Identity (TID)</b> login.<br><br>" +
                "You are signed in as <b>" + (window.GVars.user_id || "?") + "</b> via <b>" + authType + "</b>, " +
                "which has no TID token.<br><br>" +
                "Log out, then sign in with TID SSO:<br>" +
                '<a href="' + ssoUrl + '" style="color:#4da3ff;word-break:break-all;">' + ssoUrl + "</a>"
            );
            updateStatus(false);
            return;
        }

        if (window.TrimbleAgenticSDK && window.TrimbleAgenticSDK.listenToChatUi) {
            console.log("[WorkAssist] Using official Trimble iframe SDK");
            var SDK = window.TrimbleAgenticSDK;
            var targetOrigin = (SDK.CHAT_UI_URLS && SDK.CHAT_UI_URLS[ENV]) || CHAT_UI_URL;

            // Sandbox attributes required by the Chat UI (matches
            // SDK.CHAT_UI_IFRAME_SANDBOX_ATTRIBUTES).
            var sandboxAttrs = SDK.CHAT_UI_IFRAME_SANDBOX_ATTRIBUTES ||
                "allow-same-origin allow-scripts allow-popups allow-downloads allow-forms";
            iframe.setAttribute("sandbox", sandboxAttrs);

            // The SDK responds to iframe requests; the child navigates itself
            // once it receives config, but we still set src to the embed origin.
            iframe.src = targetOrigin;

            // listenToChatUi(iframe, targetOrigin, provideChatUiConfig,
            //   provideChatUiToken, onBeforeRun?, onUnauthorized?, hostTools?, onMcpAppOpenLink?)
            // onBeforeRun is the 5th positional arg. The SDK accepts either a
            // static OnBeforeRunConfig ({ tools, runContext }) OR an async
            // OnBeforeRunProvider (agentId) => Promise<OnBeforeRunConfig>. We use
            // the PROVIDER form: the parent handler awaits it and replies to the
            // child's callOnBeforeRun request. Passing a static object caused the
            // child to hit its 30s onBeforeRun timeout and fall back to an empty
            // result (no runContext, no DOM/API tools reaching the agent).
            var onBeforeRunProvider = function (agentId) {
                return Promise.resolve(buildOnBeforeRunConfig());
            };
            window._taUnsubscribe = SDK.listenToChatUi(
                iframe,
                targetOrigin,
                buildChatConfig,
                provideToken,
                onBeforeRunProvider,
                handleUnauthorized
            );

            // Surface chat UI lifecycle events (best-effort; API is optional).
            if (SDK.listenToChatUiEvents) {
                try {
                    window._taEventUnsub = SDK.listenToChatUiEvents(targetOrigin, handleEvent);
                } catch (e) { /* non-fatal */ }
            }
            if (SDK.subscribeToChatEvents) {
                try {
                    window._taChatEventUnsub = SDK.subscribeToChatEvents(targetOrigin, handleEvent);
                } catch (e) { /* non-fatal */ }
            }

            showIframe();
            updateStatus(true);
            return;
        }

        console.log("[WorkAssist] SDK not found, using direct iframe embed (fallback)");
        // Fallback still targets the frameable embed.* domain. Note: without the
        // SDK the agentId query param may be ignored and local tools won't bridge
        // — load trimble-sdk.js for full functionality.
        iframe.setAttribute("sandbox",
            "allow-same-origin allow-scripts allow-popups allow-downloads allow-forms");
        var embedUrl = CHAT_UI_URL + "/?agentId=" + AGENT_ID + "&theme=" + THEME;
        iframe.src = embedUrl;

        window.addEventListener("message", handlePostMessage);

        var loadTimeout = setTimeout(function () {
            console.warn("[WorkAssist] Iframe load timeout");
            showError();
            updateStatus(false);
        }, 15000);

        iframe.addEventListener("load", function () {
            clearTimeout(loadTimeout);
            console.log("[WorkAssist] Iframe loaded");
            showIframe();
            updateStatus(true);
            setTimeout(function () {
                if (iframe.contentWindow) {
                    iframe.contentWindow.postMessage({
                        type: "config_response",
                        config: buildChatConfig()
                    }, CHAT_UI_URL);
                }
            }, 1000);
        });

        iframe.addEventListener("error", function () {
            clearTimeout(loadTimeout);
            console.error("[WorkAssist] Iframe failed to load");
            showError();
            updateStatus(false);
        });
    }

    function provideToken() {
        return Promise.resolve(window.GVars.access_token);
    }

    // Called by the SDK when the Chat UI reports the token was rejected (401).
    // The TID token is minted at page load (w_gvars.jsp); we cannot silently
    // refresh it here, so re-provide the current one. If it's still invalid the
    // user must re-authenticate via TID SSO. Returning undefined signals "no
    // new token available".
    function handleUnauthorized() {
        var token = window.GVars && window.GVars.access_token;
        if (token && String(token).trim() && String(token) !== "null" && String(token) !== "undefined") {
            return Promise.resolve(token);
        }
        console.warn("[WorkAssist] Chat UI reported unauthorized and no TID token is available.");
        return Promise.resolve(undefined);
    }

    function handleEvent(event) {
        console.log("[TrimbleAssist] Event:", event);
        var type = event && event.type;
        var id = extractThreadId(event);
        if (id && (type === "thread:created" || type === "thread:changed" ||
                type === "onThreadSelect" || type === "run:started")) {
            taSet(TA_THREAD, id);
            debugLog("Saved thread " + id);
        }
    }

    // -----------------------------------------------------------------------
    // PostMessage bridge – handles requests from the Trimble iframe
    // -----------------------------------------------------------------------

    var _debugLog = [];
    function debugLog(msg) {
        var entry = new Date().toLocaleTimeString() + " " + msg;
        _debugLog.push(entry);
        console.log("[TrimbleAssist] " + msg);
        var el = document.getElementById("ta-debug");
        if (el) {
            el.textContent = _debugLog.slice(-8).join("\n");
            el.style.display = "block";
        }
    }

    function handlePostMessage(event) {
        var data = event.data;
        if (!data || typeof data !== "object") return;
        if (typeof data === "string") { try { data = JSON.parse(data); } catch(e) { return; } }

        var msgType = data.type || data.action || data.method || data.event || "?";
        debugLog("MSG from " + event.origin + ": " + msgType + " keys=" + Object.keys(data).join(","));

        // Token request (multiple known formats)
        if (data.type === "token_request" || data.action === "getToken" ||
            data.type === "REQUEST_TOKEN" || data.method === "getToken") {
            var iframe = document.getElementById("ta-chat-iframe");
            if (iframe && iframe.contentWindow) {
                iframe.contentWindow.postMessage({ type: "token_response", token: window.GVars.access_token }, event.origin);
                iframe.contentWindow.postMessage({ type: "TOKEN_RESPONSE", token: window.GVars.access_token }, event.origin);
                debugLog("Sent token response");
            }
            return;
        }

        // Config request
        if (data.type === "config_request" || data.action === "getConfig" ||
            data.type === "REQUEST_CONFIG" || data.method === "getConfig") {
            var iframe = document.getElementById("ta-chat-iframe");
            if (iframe && iframe.contentWindow) {
                var cfg = buildChatConfig();
                iframe.contentWindow.postMessage({ type: "config_response", config: cfg }, event.origin);
                iframe.contentWindow.postMessage({ type: "CONFIG_RESPONSE", config: cfg }, event.origin);
                debugLog("Sent config response");
            }
            return;
        }

        // Tool registration request
        if (data.type === "REQUEST_TOOLS" || data.type === "request_tools" ||
            data.method === "getTools" || data.action === "getTools") {
            var iframe = document.getElementById("ta-chat-iframe");
            var toolDefs = Object.keys(LOCAL_TOOLS).map(function(k) { return LOCAL_TOOLS[k].definition; });
            if (iframe && iframe.contentWindow) {
                iframe.contentWindow.postMessage({ type: "TOOLS_RESPONSE", tools: toolDefs }, event.origin);
                iframe.contentWindow.postMessage({ type: "tools_response", tools: toolDefs }, event.origin);
                debugLog("Sent " + toolDefs.length + " tool definitions");
            }
            return;
        }

        // Tool call from the AI agent (try ALL known formats)
        var toolName = data.toolName || data.name || data.tool_name ||
                       (data.tool && data.tool.name) ||
                       (data.payload && data.payload.toolName) ||
                       (data.payload && data.payload.name);
        var toolArgs = data.arguments || data.args || data.input || data.params ||
                       (data.tool && data.tool.arguments) ||
                       (data.payload && data.payload.arguments) ||
                       (data.payload && data.payload.args) || {};
        var callId   = data.callId || data.id || data.requestId || data.tool_call_id ||
                       (data.payload && (data.payload.callId || data.payload.id));

        if (toolName && LOCAL_TOOLS[toolName]) {
            debugLog("TOOL CALL: " + toolName + " id=" + callId);

            LOCAL_TOOLS[toolName].callback(typeof toolArgs === "string" ? JSON.parse(toolArgs) : toolArgs)
                .then(function (result) {
                    debugLog("TOOL OK: " + toolName + " (" + (result || "").length + " chars)");
                    sendToolResult(event.origin, callId, result, null, data);
                })
                .catch(function (err) {
                    debugLog("TOOL ERR: " + toolName + " " + err.message);
                    sendToolResult(event.origin, callId, null, err.message || String(err), data);
                });
            return;
        }

        // Log unhandled messages with tool-like content for debugging
        if (toolName) {
            debugLog("UNKNOWN TOOL: " + toolName + " (not in LOCAL_TOOLS)");
        }
    }

    function sendToolResult(origin, callId, result, error, originalMsg) {
        var iframe = document.getElementById("ta-chat-iframe");
        if (!iframe || !iframe.contentWindow) return;

        var formats = [
            { type: "tool_result", callId: callId, result: result, error: error },
            { type: "TOOL_RESULT", callId: callId, result: result, error: error },
            { type: "tool_response", id: callId, output: result, error: error },
            { type: "TOOL_RESPONSE", requestId: callId, result: result, error: error }
        ];

        formats.forEach(function (msg) {
            iframe.contentWindow.postMessage(msg, origin);
        });
    }

    function updateStatus(connected) {
        var dot = document.querySelector(".ta-panel__status-dot");
        if (dot) {
            dot.className = connected
                ? "ta-panel__status-dot"
                : "ta-panel__status-dot ta-panel__status-dot--error";
        }
    }

    // -----------------------------------------------------------------------
    // Public API – exposed on window for SDK integration
    // -----------------------------------------------------------------------

    window.TrimbleAssistConfig = {
        agentId:     AGENT_ID,
        environment: ENV,
        chatUiUrl:   CHAT_UI_URL,
        getOnBeforeRunConfig: buildOnBeforeRunConfig,
        getChatConfig:        buildChatConfig,
        provideToken:         provideToken,
        localTools:           LOCAL_TOOLS
    };

    // -----------------------------------------------------------------------
    // Boot
    // -----------------------------------------------------------------------

    loadWindowCatalog();
    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", buildUI);
    } else {
        buildUI();
    }

    console.log("[WorkAssist] Loaded v=" + ASSET_VER + " – Agent: " + AGENT_ID + " Env: " + ENV);

})();
