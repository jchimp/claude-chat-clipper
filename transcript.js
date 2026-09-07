// =============================================================================
// transcript.js — pure functions. Raw conversation JSON -> normalized
// transcript (full archive, for the JSON export) -> Markdown (visible text +
// artifacts, for pasting). No DOM access, so this file is unit-testable.
// =============================================================================
(function () {
  const NS = (window.__claudeClipper = window.__claudeClipper || {});

  // Order the messages along the branch currently shown on screen. With
  // tree=True the payload includes every edited/retried branch; the leaf
  // pointer tells us which one is live. Fallback: payload order by index.
  function activePath(raw) {
    const msgs = Array.isArray(raw.chat_messages) ? raw.chat_messages : [];
    const byId = new Map(msgs.map((m) => [m.uuid, m]));
    let cur = raw.current_leaf_message_uuid ? byId.get(raw.current_leaf_message_uuid) : null;
    if (!cur) {
      return msgs.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    }
    const path = [];
    const seen = new Set();
    while (cur && !seen.has(cur.uuid)) {
      seen.add(cur.uuid);
      path.push(cur);
      cur = byId.get(cur.parent_message_uuid);
    }
    return path.reverse();
  }

  function blocksOf(m) {
    if (Array.isArray(m.content) && m.content.length) return m.content;
    // Older payload shape: flat text on the message.
    return m.text ? [{ type: "text", text: m.text }] : [];
  }

  function attachmentNames(m) {
    const names = [];
    for (const a of m.attachments || []) if (a && a.file_name) names.push(a.file_name);
    for (const f of m.files || []) if (f && f.file_name) names.push(f.file_name);
    return names;
  }

  NS.toTranscript = function toTranscript(raw, url) {
    const path = activePath(raw);
    return {
      schema: 1,
      source: "api",
      assistant: "Claude",
      title: (raw.name || "").trim() || "Untitled conversation",
      model: raw.model || "",
      url: url || "",
      conversationId: raw.uuid || "",
      createdAt: raw.created_at || null,
      updatedAt: raw.updated_at || null,
      clippedAt: new Date().toISOString(),
      turns: path.map((m) => ({
        uuid: m.uuid,
        role: m.sender === "human" ? "user" : "assistant",
        timestamp: m.created_at || null,
        blocks: blocksOf(m),
        attachments: attachmentNames(m),
      })),
    };
  };

  // ---------------------------------------------------------------------------
  // Markdown rendering
  // ---------------------------------------------------------------------------

  const MIME_LANG = {
    "application/vnd.ant.code": "",
    "application/vnd.ant.react": "jsx",
    "application/vnd.ant.mermaid": "mermaid",
    "text/markdown": "markdown",
    "text/html": "html",
    "image/svg+xml": "svg",
  };

  function artifactLang(input) {
    if (input.language) return String(input.language);
    return MIME_LANG[input.type] || "";
  }

  // A fence must be longer than any backtick run inside the content, otherwise
  // the block closes early. Three is the minimum; grow as needed.
  function fence(content) {
    const runs = content.match(/`{3,}/g) || [];
    const longest = runs.reduce((n, r) => Math.max(n, r.length), 0);
    return "`".repeat(Math.max(3, longest + 1));
  }

  function codeBlock(lang, content) {
    const f = fence(content);
    return `${f}${lang}\n${content.replace(/\n$/, "")}\n${f}`;
  }

  // Artifacts arrive as tool_use ops (create / update / rewrite). Fold them per
  // artifact id so each turn shows the artifact as it stood at the end of that
  // turn, once, instead of a diff trail. `state` persists across turns.
  function applyArtifactOp(state, input) {
    const id = input.id || "artifact";
    const prev = state.get(id) || { title: "", language: "", content: "" };
    const next = { ...prev };
    if (input.title) next.title = input.title;
    const lang = artifactLang(input);
    if (lang) next.language = lang;
    switch (input.command) {
      case "create":
      case "rewrite":
        next.content = input.content || "";
        break;
      case "update":
        if (typeof input.old_str === "string" && prev.content.includes(input.old_str)) {
          next.content = prev.content.replace(input.old_str, input.new_str || "");
        } else if (typeof input.new_str === "string" && !prev.content) {
          next.content = input.new_str;
        }
        break;
      default:
        if (input.content) next.content = input.content;
    }
    state.set(id, next);
    return id;
  }

  function renderTurn(turn, artifactState) {
    const parts = [];
    const touched = [];
    for (const b of turn.blocks) {
      if (!b || typeof b !== "object") continue;
      switch (b.type) {
        case "text":
          if (b.text && b.text.trim()) parts.push(b.text.trim());
          break;
        case "tool_use": {
          const input = b.input || {};
          if (b.name === "artifacts" && input.command) {
            const id = applyArtifactOp(artifactState, input);
            if (!touched.includes(id)) touched.push(id);
          } else if (b.name) {
            parts.push(`_Used tool: ${b.name}_`);
          }
          break;
        }
        // thinking / tool_result / anything else: archive-only, not visible copy.
        default:
          break;
      }
    }
    for (const id of touched) {
      const a = artifactState.get(id);
      if (!a || !a.content) continue;
      const title = a.title ? `**Artifact: ${a.title}**\n\n` : "**Artifact**\n\n";
      parts.push(title + codeBlock(a.language, a.content));
    }
    if (turn.attachments && turn.attachments.length) {
      parts.push(`_Attached: ${turn.attachments.join(", ")}_`);
    }
    return parts.join("\n\n");
  }

  NS.toMarkdown = function toMarkdown(t) {
    const head = [`# ${t.title}`, ""];
    if (t.url) head.push(`- Source: ${t.url}`);
    if (t.model) head.push(`- Model: ${t.model}`);
    if (t.createdAt) head.push(`- Started: ${t.createdAt}`);
    head.push(`- Clipped: ${t.clippedAt || new Date().toISOString()}`);
    if (t.source && t.source !== "api") {
      head.push(`- Captured via: ${t.source}${t.warning ? " (" + t.warning + ")" : ""}`);
    }
    head.push("", "---", "", "");

    const artifactState = new Map();
    const body = t.turns.map((turn) => {
      const label = turn.role === "user" ? "## 🧑 You" : `## 🤖 ${t.assistant || "Claude"}`;
      const md = renderTurn(turn, artifactState);
      return `${label}\n\n${md || "_(no visible text)_"}`;
    });
    return (head.join("\n") + body.join("\n\n") + "\n").replace(/\n{3,}/g, "\n\n");
  };

  // "YYYY-MM-DD Title.md" — dated by when the conversation started so the
  // archive sorts chronologically, not by when you happened to clip it.
  NS.buildFilename = function buildFilename(t) {
    const when = t.createdAt ? new Date(t.createdAt) : new Date();
    const date = isNaN(when) ? new Date().toISOString().slice(0, 10) : when.toISOString().slice(0, 10);
    const safeTitle = (t.title || "chat")
      .replace(/[\\/:*?"<>|]+/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 80);
    return `${date} ${safeTitle || "chat"}.md`;
  };

  NS._activePath = activePath; // exposed for tests
})();
