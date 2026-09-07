// =============================================================================
// api.js — fetch the open conversation from claude.ai's own JSON endpoint.
// Runs inside the page (injected), so the request is same-origin and carries
// the session cookie. No scrolling, no selectors: this is the primary path.
// =============================================================================
(function () {
  const NS = (window.__claudeClipper = window.__claudeClipper || {});

  function readCookie(name) {
    const m = document.cookie.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]+)"));
    return m ? decodeURIComponent(m[1]) : "";
  }

  async function getJson(path) {
    const res = await fetch(path, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
    return res.json();
  }

  // claude.ai remembers the active org in a plain cookie; fall back to listing
  // orgs if the cookie is absent (fresh session, cookie renamed, etc.).
  async function getOrgId() {
    const fromCookie = readCookie("lastActiveOrg");
    if (fromCookie) return fromCookie;
    const orgs = await getJson("/api/organizations");
    if (!Array.isArray(orgs) || !orgs.length || !orgs[0].uuid) {
      throw new Error("No organization found for this session.");
    }
    return orgs[0].uuid;
  }

  function getConversationId() {
    const m = location.pathname.match(/\/chat\/([0-9a-f-]{36})/i);
    if (!m) throw new Error("Not on a conversation page (expected /chat/<uuid>).");
    return m[1];
  }

  // tree=True returns every branch; transcript.js walks the active one.
  // render_all_tools=true makes tool_use/tool_result blocks explicit so the
  // JSON archive is complete.
  NS.fetchConversation = async function fetchConversation() {
    const orgId = await getOrgId();
    const convId = getConversationId();
    const path =
      `/api/organizations/${encodeURIComponent(orgId)}` +
      `/chat_conversations/${encodeURIComponent(convId)}` +
      `?tree=True&rendering_mode=messages&render_all_tools=true`;
    const raw = await getJson(path);
    if (!raw || !Array.isArray(raw.chat_messages)) {
      throw new Error("Conversation JSON had no chat_messages array.");
    }
    return raw;
  };
})();
