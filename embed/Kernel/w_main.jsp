<%@ page language="java" import="com.agileassetsinc.core.*"%>
<%@ page import="com.agileassetsinc.core.session.SessionManager"%>
<%@ page import="com.agileassetsinc.core.cache.TextResourcesCache"%>
<%@ page import="org.webjars.WebJarAssetLocator" %>
<%@ page import="java.util.LinkedHashSet" %>
<%@ page import="java.util.Set" %>
<%@ page import="static org.apache.commons.lang3.StringUtils.isBlank" %>
<%@ page import="java.util.Optional" %>
<%@ page session="false"%>

<%
    response.setHeader("Cache-Control", "no-store, no-cache"); //HTTP 1.1
    response.setHeader("Pragma","no-cache"); //HTTP 1.0
    response.setDateHeader ("Expires", 0); //prevents caching at the proxy server
    response.addHeader("Content-Type", "text/html; charset="+SystemSetup.getDefaultEncoding());

    String sessionId = request.getParameter(TRDIConstants.SESSION_ID_VAR_NAME);
    ServerSession ss = SessionManager.getInstance().getSession(sessionId);

    // Check if Unity deployment. If so, update the context path
    boolean isUnity = SystemSetup.getInstance().isUnityDeployment();
    // In Unity, this will be /ams-web
    String servletContextPath = SystemSetup.getInstance().getServletContextPath();
    // In Unity, this will be /$getUnityTenantId/pavement/apps/ams-web
    String fullServletContextPath = isUnity ? SystemSetup.getInstance().getUnityPath(servletContextPath) : servletContextPath;

    String windowLinkUrl = null;
    try {
        windowLinkUrl = new Bookmark(request.getQueryString()).toWindowMenuUrl(request.getParameter(Bookmark.MENU_ID_TAG));
        if(windowLinkUrl.length()>0) {
            ss.setAttribute(ServerSession.WINDOW_LINK_URL_ATTR_KEY, windowLinkUrl);
        }
    }
    catch(Exception e) {
        windowLinkUrl = null;
    }

    // if the user session has a postLogoutUrl set, redirect user there (used with SSO). Otherwise, use system timeout page.
    String timeout_page = Optional.ofNullable(ss.getPostLogoutUrl()).orElse(SystemSetup.getInstance().getTimeoutPage());
    if (isBlank(timeout_page) || !timeout_page.toLowerCase().startsWith("http")) {
        timeout_page = request.getContextPath() + SystemSetup.getInstance().getTimeoutPage();
    }

    Set<String> scripts = new LinkedHashSet<String>();
    Set<String> scriptsNonAsync = new LinkedHashSet<String>();
    WebJarAssetLocator locator = new WebJarAssetLocator();

    // Since downstream code prepends the Unity stuff, use `servletContextPath` not `fullServletContextPath` here.
    scriptsNonAsync.add(servletContextPath + locator.getFullPath("wgxpath.install.js").replace("META-INF/resources", ""));
    scriptsNonAsync.add("div.js");
    scriptsNonAsync.add("tooltip");
    scriptsNonAsync.add("utils.js");
    scriptsNonAsync.add("w_main");
    scripts.add("general.css");
%>

<!DOCTYPE HTML PUBLIC "-//W3C//DTD HTML 4.01//EN" "http://www.w3.org/TR/html4/strict.dtd">

<html lang="en" style="overflow:hidden;">
<head>
    <title></title>
    <meta http-equiv="Content-Type" content="text/html; charset=UTF-8"/>
    <%=BasicWindow.getIncludeFilesStr(ss, scripts, true, BasicWindow.IncludeScriptType.CSS)%>
    <%=BasicWindow.getIncludeFilesStr(ss, scriptsNonAsync, false, BasicWindow.IncludeScriptType.CSS)%>
    <%=BasicWindow.getIncludeFilesStr(ss, scripts, true, BasicWindow.IncludeScriptType.JS)%>
    <%=BasicWindow.getIncludeFilesStr(ss, scriptsNonAsync, false, BasicWindow.IncludeScriptType.JS)%>


    <link rel="shortcut icon" type="image/x-icon" href="<%=fullServletContextPath%>/Images/favicon.ico"/>
    <link rel="apple-touch-icon" href="<%=fullServletContextPath%>/Images/apple-touch-icon.png"/>

    <%@ include file="w_gvars.jsp" %> <%-- static include --%>

<%--for ipad to reload instead of showing old state of page...--%>
    <script type="text/javascript">

        window.onpageshow = function (evt) {
            // If persisted then it is in the page cache, force a reload of the page.
            if (evt.persisted) {
                document.body.style.display = "none";
                location.reload();
            }
        };

    </script>


    <script type="text/javascript">
        window.adjustWalkMePlayerButtonPosition = function() {
            if(window.top._adjustWalkmePlayerButtonPosition) {
                var walkme = window.top.document.getElementById("walkme-player");
                if (walkme) {
                    var mBottom = 32, mRight = 21;
                    var scrollBarSize = Utils.GetScrollBarSize(false);
                    if (scrollBarSize) {
                        mBottom += scrollBarSize;
                        mRight += scrollBarSize / 2;
                    }
                    walkme.setAttribute("style",  "margin-bottom:" + mBottom + "px !important;margin-right:" + mRight + "px !important");
                }
            }
        };
        <%--change position when player button is built. https://developer.walkme.com/reference#events --%>
        window.walkme_event = function(eventData) {
            if (eventData.Type === "PlayerBuilt") {
                adjustWalkMePlayerButtonPosition();
            }
        };
        (function() {
            if (GVars.Features.isWalkMeEnabled) {

                var walkme = document.createElement('script');
                walkme.type = 'text/javascript';
                walkme.async = true;
                walkme.src = GVars.walkMeUrl;
                var s = document.getElementsByTagName('script')[0];
                s.parentNode.insertBefore(walkme, s);
                window._walkmeConfig = {smartLoad: true};

                // Setting walkMe user variables for segmentation
                window.walkMe = {};
                window.walkMe.userId = GVars.user_id;
                window.walkMe.adminUnit = GVars.owner_id;
                window.walkMe.securityRole = GVars.sample_id;
                window.walkMe.client = GVars.customer_project_id;
                window.walkMe.sessionId = GVars.aa_sid;
            }
        })();
    </script>

    <script type="text/javascript">
        wgxpath.install();
    </script>

    <%-- Trimble Agentic AI Assist – floating chat panel --%>
    <%-- trimble-sdk.js must load first: it exposes window.TrimbleAgenticSDK
         (official iframe SDK bundle). Both use defer, which preserves order. --%>
    <link rel="stylesheet" href="<%=fullServletContextPath%>/Kernel/trimble-assist.css?v=20260817a"/>
    <script type="text/javascript" src="<%=fullServletContextPath%>/Kernel/trimble-sdk.js?v=20260817a" defer></script>
    <script type="text/javascript" src="<%=fullServletContextPath%>/Kernel/trimble-assist.js?v=20260817a" defer></script>

    <script type="text/javascript">
        var timeout_page = "<%=timeout_page%>";
        if (GVars.client_tablet) {
            window.onorientationchange = OnResize;
        }
        else {
            window.onresize = OnResize;
        }

        window.onbeforeunload = OnBeforeUnload;
        window.onscroll = OnScroll;

    </script>
</head>

<body id="main_body" onunload="OnExit()" onload="OnLoad()" <%--onresize="OnResize()"--%>>

<div id="status_text_container">
    <div id="status_text"></div>
    <span id="close_status_text" onclick="ClearStatusText()">X</span>
</div>

<h1 id="win_hdng" class="accessibility_compliance"></h1>
<h2 <%--id="win_nav" --%>class="accessibility_compliance">Navigation</h2>
<ul <%--id="win_reload"--%> class="accessibility_compliance">
<li>
<a href="<%=timeout_page%>">Exit</a>
</li>
</ul>
<div id="main_div">
<div id="wrk_div">
    <%--iframe will not reload for ie10 when using back and forward buttons if using src="../Kernel/w_load.html"--%>
    <iframe name="wrk_frame" id="wrk_frame" scrolling="auto" frameborder="0"
            title="<%=TRDIUtils.escapeStringForHtml(TextResourcesCache.getInstance().getTextResource(846, SystemSetup.getInstance().getVersionSequence(), SystemSetup.getInstance().getBuildNumber()))%>"></iframe>
</div>
</div>
</body>
</html>
