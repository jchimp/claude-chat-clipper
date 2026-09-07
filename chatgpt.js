// =============================================================================
// chatgpt.js — ChatGPT provider: API fetch, raw JSON -> transcript, DOM
// fallback. Produces the same transcript shape as transcript.js so toMarkdown
// and buildFilename work unchanged. Registered by clip.js for chatgpt.com.
// =============================================================================
(function () {
  const NS = (window.__claudeClipper = window.__claudeClipper || {});
  const ASSISTANT = "ChatGPT";

  // ---------------------------------------------------------------------------
  // API
  // ---------------------------------------------------------------------------

  function readCookie(name) {
    const m = document.cookie.match(new RegExp("(?:^|;\s*)" + name + "=([^;]+)"));
    return m ? decodeURIComponent(m[1]) : "";
  }

  // Matches /c/<uuid> and custom-GPT paths like /g/<gizmo>/c/<uuid>.
  function getConversationId() {
    const m = location.pathname.match(/\/c\/([0-9a-f-]{36})/i);
    if (!m) throw new Error("Not on a conversation page (expected /c/<uuid>).");
    return m[1];
  }

  async function getJson(path, headers) {
    const res = await fetch(path, { credentials: "same-origin", headers: { accept: "application/json", ...headers } });
    if (!res.ok) throw new Error(`GET ${path} -> HTTP ${res.status}`);
    return res.json();
  }

  // The backend requires a bearer token; the session endpoint hands it out to
  // same-origin callers with the login cookie. Empty body = logged out.
  async function getAccessToken() {
    const session = await getJson("/api/auth/session", {});
    if (!session || !session.accessToken) throw new Error("No access token (logged out?).");
    return session.accessToken;
  }

  async function fetchConversation() {
    const convId = getConversationId();
    const token = await getAccessToken();
    const headers = { authorization: `Bearer ${token}` };
    // Sent by the page itself; harmless if the backend stops checking it.
    const deviceId = readCookie("oai-did");
    if (deviceId) headers["oai-device-id"] = deviceId;
    const raw = await getJson(`/backend-api/conversation/${encodeURIComponent(convId)}`, headers);
    if (!raw || typeof raw.mapping !== "object" || raw.mapping === null) {
      throw new Error("Conversation JSON had no mapping object.");
    }
    return raw;
  }

  // ---------------------------------------------------------------------------
  // Raw JSON -> transcript
  // ---------------------------------------------------------------------------

  // mapping is { id: { id, parent, children, message } }; current_node is the
  // leaf of the branch on screen. Walk parents to the root. Fallback: every
  // node ordered by create_time.
  function activePath(raw) {
    const mapping = raw.mapping || {};
    let cur = raw.current_node ? mapping[raw.current_node] : null;
    if (!cur) {
      return Object.values(mapping).sort(
        (a, b) => ((a.message && a.message.create_time) || 0) - ((b.message && b.message.create_time) || 0)
      );
    }
    const path = [];
    const seen = new Set();
    while (cur && !seen.has(cur.id)) {
      seen.add(cur.id);
      path.push(cur);
      cur = cur.parent ? mapping[cur.parent] : null;
    }
    return path.reverse();
  }

  function isoFromSeconds(s) {
    if (typeof s !== "number" || !isFinite(s)) return null;
    return new Date(s * 1000).toISOString();
  }

  // Visible text becomes a `text` block so transcript.js renders it. Every
  // other content_type (thoughts, reasoning_recap, code, execution_output,
  // tether_*) is passed through under its own type: archived in the JSON,
  // skipped in the Markdown, like Claude's `thinking`.
  function blocksOf(content) {
    if (!content || typeof content !== "object") return [];
    const type = content.content_type || "unknown";
    if (type === "text" || type === "multimodal_text") {
      const parts = (content.parts || []).map((p) => (typeof p === "string" ? p : "_[image]_"));
      const text = parts.filter((p) => p.trim()).join("\n\n");
      return text ? [{ type: "text", text }] : [];
    }
    return [{ ...content, type }];
  }

  function attachmentNames(msg) {
    const meta = (msg && msg.metadata) || {};
    return (meta.attachments || []).map((a) => a && a.name).filter(Boolean);
  }

  function toTranscript(raw, url) {
    const turns = [];
    let model = raw.default_model_slug || "";
    for (const node of activePath(raw)) {
      const msg = node.message;
      if (!msg || !msg.author) continue;
      const role = msg.author.role;
      if (role !== "user" && role !== "assistant") continue; // system, tool
      if (msg.metadata && msg.metadata.is_visually_hidden_from_conversation) continue;
      if (!model && msg.metadata && msg.metadata.model_slug) model = msg.metadata.model_slug;
      const blocks = blocksOf(msg.content);
      const attachments = attachmentNames(msg);
      const last = turns[turns.length - 1];
      // One on-screen reply can span several assistant nodes (reasoning, then
      // the answer); merge them so the Markdown shows a single heading.
      if (last && last.role === role) {
        last.blocks.push(...blocks);
        last.attachments.push(...attachments);
        continue;
      }
      turns.push({
        uuid: msg.id || node.id,
        role,
        timestamp: isoFromSeconds(msg.create_time),
        blocks,
        attachments,
      });
    }
    return {
      schema: 1,
      source: "api",
      assistant: ASSISTANT,
      title: (raw.title || "").trim() || "Untitled conversation",
      model,
      url: url || "",
      conversationId: raw.conversation_id || raw.id || "",
      createdAt: isoFromSeconds(raw.create_time),
      updatedAt: isoFromSeconds(raw.update_time),
      clippedAt: new Date().toISOString(),
      turns,
    };
  }

  // ---------------------------------------------------------------------------
  // DOM fallback
  // ---------------------------------------------------------------------------

  // ChatGPT tags both roles, so no structural climb is needed.
  const TURN_SEL = "[data-message-author-role]";
  const PRUNE_SEL = ".sr-only, button";

  function prepare(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll(PRUNE_SEL).forEach((n) => n.remove());
    return clone;
  }

  function title() {
    const t = document.title.replace(/\s+/g, " ").trim();
    return t && t !== ASSISTANT ? t : "Untitled conversation";
  }

  function domFallback(url) {
    const els = Array.from(document.querySelectorAll(TURN_SEL)).filter((el) => {
      const r = el.getAttribute("data-message-author-role");
      return r === "user" || r === "assistant";
    });
    if (!els.length) throw new Error("No message rows found in the DOM.");
    const convId = (location.pathname.match(/\/c\/([0-9a-f-]{36})/i) || [])[1] || "";
    return {
      schema: 1,
      source: "dom",
      assistant: ASSISTANT,
      title: title(),
      model: "",
      url: url || location.href,
      conversationId: convId,
      createdAt: null,
      updatedAt: null,
      clippedAt: new Date().toISOString(),
      turns: els.map((el) => ({
        uuid: el.getAttribute("data-message-id") || "",
        role: el.getAttribute("data-message-author-role"),
        timestamp: null,
        blocks: [{ type: "text", text: NS.htmlToMarkdown(prepare(el)) }],
        attachments: [],
      })),
    };
  }

  NS.chatgpt = { fetchConversation, toTranscript, domFallback, _activePath: activePath };
})();
