// =============================================================================
// dom-fallback.js — single-pass structural scrape of the rendered chat.
// Only runs when the API path fails (endpoint changed, logged-out tab, etc.).
// Claude reliably tags user messages (data-testid="user-message") and nothing
// else, so: find the container the user rows live in, then treat every other
// child row with text as an assistant turn. No scrolling: turn rows stay in
// the DOM under `content-visibility: auto`, so textContent is populated even
// when innerText is not.
// =============================================================================
(function () {
  const NS = (window.__claudeClipper = window.__claudeClipper || {});

  const USER_SEL = 'div[data-testid="user-message"]';
  // Assistant-only action buttons; used to recognise the conversation container.
  const ASSISTANT_ANCHOR_SEL = '[data-testid="action-bar-read-aloud"], [data-testid="action-bar-retry"]';
  // Chrome removed before conversion: screen-reader preview headings and the
  // per-turn button row.
  const PRUNE_SEL = '.sr-only, [data-testid^="action-bar-"]';
  // Widgets whose content is not recoverable from the DOM; replaced with a
  // placeholder so the turn is never dropped as empty.
  const PLACEHOLDER_SEL = '[data-testid="artifact-block-cell"], [data-testid="tool-use"]';

  function lca(a, b) {
    const anc = new Set();
    for (let x = a; x; x = x.parentElement) anc.add(x);
    let y = b;
    while (y && !anc.has(y)) y = y.parentElement;
    return y || null;
  }

  function commonAncestor(els) {
    return els.reduce((acc, el) => (acc ? lca(acc, el) : el), null);
  }

  // The container whose direct children are the turn rows. With several user
  // messages their common ancestor is it. With one user message the "common
  // ancestor" is the message itself, so climb until the candidate holds at
  // least two rows and (if the page has any) an assistant action bar.
  function findStream(users) {
    const main = document.querySelector("main") || document.body;
    let stream = commonAncestor(users);
    if (!stream) return null;
    if (users.includes(stream)) stream = stream.parentElement;
    const pageHasAnchor = !!document.querySelector(ASSISTANT_ANCHOR_SEL);
    while (
      stream &&
      stream !== main &&
      stream.parentElement &&
      (stream.children.length < 2 || (pageHasAnchor && !stream.querySelector(ASSISTANT_ANCHOR_SEL)))
    ) {
      stream = stream.parentElement;
    }
    return stream;
  }

  function structuralTurns(stream) {
    const out = [];
    for (const child of Array.from(stream.children)) {
      const userEl = child.matches(USER_SEL) ? child : child.querySelector(USER_SEL);
      if (userEl) {
        out.push({ role: "user", el: userEl });
        continue;
      }
      const txt = (child.textContent || "").replace(/\s+/g, " ").trim();
      if (txt.length) out.push({ role: "assistant", el: child });
    }
    return out;
  }

  // Work on a clone so the live page is never mutated.
  function prepare(el) {
    const clone = el.cloneNode(true);
    clone.querySelectorAll(PRUNE_SEL).forEach((n) => n.remove());
    clone.querySelectorAll(PLACEHOLDER_SEL).forEach((n) => {
      const p = document.createElement("p");
      p.textContent = "_[artifact or tool output omitted: DOM fallback]_";
      n.replaceWith(p);
    });
    return clone;
  }

  function title() {
    const btn = document.querySelector('button[data-testid="chat-title-button"]');
    const t = (btn && btn.textContent) || document.title.replace(/\s*[-|]\s*Claude.*/i, "");
    return t.replace(/\s+/g, " ").trim() || "Untitled conversation";
  }

  function model() {
    const el = document.querySelector('[data-testid="model-selector-dropdown"]');
    return el ? el.textContent.replace(/\s+/g, " ").trim() : "";
  }

  NS.domFallback = function domFallback(url) {
    const users = Array.from(document.querySelectorAll(USER_SEL));
    if (!users.length) throw new Error("No user messages found in the DOM.");
    const stream = findStream(users);
    if (!stream) throw new Error("Could not locate the conversation container.");
    const turns = structuralTurns(stream);
    if (!turns.length) throw new Error("Conversation container had no turn rows.");

    const convId = (location.pathname.match(/\/chat\/([0-9a-f-]{36})/i) || [])[1] || "";
    return {
      schema: 1,
      source: "dom",
      assistant: "Claude",
      title: title(),
      model: model(),
      url: url || location.href,
      conversationId: convId,
      createdAt: null,
      updatedAt: null,
      clippedAt: new Date().toISOString(),
      turns: turns.map((t) => ({
        uuid: "",
        role: t.role,
        timestamp: null,
        blocks: [{ type: "text", text: NS.htmlToMarkdown(prepare(t.el)) }],
        attachments: [],
      })),
    };
  };
})();
