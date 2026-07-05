// =============================================================================
// adapters.js  —  THE ONLY FILE YOU SHOULD EVER NEED TO TUNE
// -----------------------------------------------------------------------------
// Each adapter tells the clipper, for one site:
//   match    : which hostnames it applies to
//   root()   : returns the DOM element that wraps the WHOLE conversation
//   turns()  : (optional) returns an ordered list of {role, el} for nicer
//              "## You / ## Assistant" splitting. If it returns null/empty,
//              the clipper falls back to converting root() as a single block.
//   title()  : (optional) best-guess conversation title for the filename
//   model()  : (optional) model name string for frontmatter
//
// HOW TO TUNE (5 minutes, per site):
//   1. Open a conversation on the site.
//   2. F12 -> Console. Paste:  window.__clipDiag && window.__clipDiag()
//      (the clipper injects __clipDiag to print what it currently matches)
//   3. If root is wrong: right-click the conversation area -> Inspect, find the
//      smallest element that contains every message, and update ROOT_SELECTORS.
//   4. Reload the page. Done.
//
// Selectors are listed most-specific-first; the first one that matches wins.
// They are intentionally a LIST so a site redesign usually just means adding
// one new selector to the front instead of rewriting anything.
// =============================================================================

const ADAPTERS = [
  // ---------------------------------------------------------------------------
  // Claude.ai
  // ---------------------------------------------------------------------------
  {
    id: "claude",
    label: "Claude",
    match: (host) => host === "claude.ai" || host.endsWith(".claude.ai"),

    ROOT_SELECTORS: [
      // Optional fast path. If none match, root() computes the stream from the
      // user-message anchors (see _stream()), so this can stay empty/wrong.
      'div[data-testid="conversation"]',
      "main div.flex.flex-col.gap-3"
    ],

    // The only element Claude reliably tags is the USER message. Assistant
    // replies have no stable testid/class, so we don't guess one — we find the
    // container the user messages live in and read the sibling blocks between
    // them as the assistant turns. (See claudeStructuralTurns / _stream below.)
    USER_SELECTORS: ['div[data-testid="user-message"]'],

    // Assistant messages carry these action buttons (assistant-only). Used only
    // as a backup anchor if the structural pass somehow finds no replies.
    ASSISTANT_ANCHOR_SELECTORS: [
      '[data-testid="action-bar-read-aloud"]',
      '[data-testid="action-bar-retry"]'
    ],

    SCROLL_SELECTORS: [
      // Current Claude scroll pane. NOT scoped to `main` — the scroller lives
      // outside it, which is why the older "main div.overflow-y-auto" missed.
      // findScrollContainer() verifies scrollability, so this wins over the
      // shorter "div.absolute.inset-0.overflow-auto" candidate on the page.
      "div.overflow-y-auto.overflow-x-hidden",
      'div[data-testid="conversation"]',
      "main div.overflow-y-auto",
      "main div.overflow-y-scroll"
    ],

    // Chrome nodes pruned from an assistant turn BEFORE html2md sees it: the
    // tool-use chip rows ("Created a file, read a file") and artifact reference
    // cards ("ReflectPY"). TUNE: confirm these against the live DOM with
    // __clipDiag() / Inspect — the exact class/testid values churn. Until a
    // selector here matches, those two artifacts will still leak through.
    PRUNE_SELECTORS: [
      // Screen-reader preview headings ("You said: …" / "Claude said: …") that
      // duplicate the visible text, and the per-turn action-bar button row
      // (Retry / Copy / Edit / Read aloud) — both leak into the markdown.
      ".sr-only",
      '[data-testid^="action-bar-"]',
      '[data-testid="artifact-block-cell"]',
      '[data-testid="tool-use"]'
    ],

    // Per-turn Markdown cleanup (normalize.js). Only Claude defines this, so
    // other adapters are untouched.
    cleanTurn(role, md) {
      return normalizeClaudeTurn(role, md);
    },

    // The element that contains every turn. Computed from the user anchors so
    // it survives Claude's class/testid churn.
    _stream() {
      const sel = firstMatch(this.ROOT_SELECTORS);
      if (sel) return sel;
      const users = Array.from(document.querySelectorAll(this.USER_SELECTORS.join(", ")));
      if (!users.length) return document.querySelector("main") || document.body;
      let stream = commonAncestor(users);
      if (!stream || users.includes(stream)) stream = users[0].parentElement;
      return stream || document.body;
    },

    root() {
      return this._stream();
    },

    turns() {
      return claudeStructuralTurns(this._stream(), this.ASSISTANT_ANCHOR_SELECTORS);
    },

    title() {
      const t =
        document.querySelector('button[data-testid="chat-title-button"]')?.innerText ||
        document.title.replace(/\s*[-|]\s*Claude.*/i, "");
      return clean(t);
    },

    model() {
      // Best-effort: the model picker usually shows the active model.
      const m = document.querySelector('[data-testid="model-selector-dropdown"]')?.innerText;
      return clean(m) || "";
    }
  },

  // ---------------------------------------------------------------------------
  // Microsoft 365 Copilot (work/school chat at m365.cloud.microsoft/chat).
  // Different DOM from consumer Copilot: keyed on the stable data-testids the
  // Scriptor-rendered chat exposes. Listed FIRST so it wins over the consumer
  // adapter for *.cloud.microsoft hosts.
  // ---------------------------------------------------------------------------
  {
    id: "m365copilot",
    label: "Microsoft 365 Copilot",
    match: (host) => host === "m365.cloud.microsoft" || host.endsWith(".cloud.microsoft"),

    ROOT_SELECTORS: ['[data-testid="MessageListContainer"]', "main"],
    SCROLL_SELECTORS: ['[data-testid="MessageListContainer"]'],

    // NOTE: M365's testid names are misleading. The USER question lives in BOTH
    // `chatQuestion` (wrapped in a stray bold + an "##### You said:" sr-label) and
    // `chatOutput` (plain, clean text) — we use chatOutput to skip that chrome.
    // The ASSISTANT reply is the clean markdown in `markdown-reply`;
    // `copilot-message-reply-div` is the same body wrapped in "Copilot said: …
    // Reasoning completed in N steps" chrome, so we avoid it.
    USER_SELECTORS: ['[data-testid="chatOutput"]'],
    // markdown-reply also tags empty data-message-type="Progress" placeholders
    // (the streaming/reasoning steps); exclude them so we don't emit empty turns.
    ASSISTANT_SELECTORS: [
      '[data-testid="markdown-reply"]:not([data-message-type="Progress"])'
    ],

    // Chrome stripped before html2md (pruneForConversion reads this generically):
    // disclaimers, citation/attribution floaties, source/feedback/copy buttons.
    PRUNE_SELECTORS: [
      '[data-testid="chat-response-message-disclaimer"]',
      '[data-testid="attribution-floatie"]',
      '[data-testid="messageAttributionIcon"]',
      '[data-testid="foot-note-div"]',
      '[data-testid="sources-button-testid"]',
      '[data-testid="feedback-button-testid"]',
      '[data-testid="FeedbackContainerTestId"]',
      '[data-testid="CopyButtonContainerTestId"]',
      '[data-testid="CopyButtonTestId"]',
      '[data-testid="overflow-menu-button"]',
      '[data-testid="edit-line-icon"]',
      '[data-testid="loading-message"]',
      '[data-testid="grounding-menu"]',
      // Inline "fai-Citation" source badges (e.g. "visualstudio", "python") that
      // glue to the end of sentences; href is empty, so nothing useful is lost.
      ".fai-Citation"
    ],

    root() {
      return firstMatch(this.ROOT_SELECTORS);
    },

    turns() {
      return unionTurns(this.USER_SELECTORS, this.ASSISTANT_SELECTORS);
    },

    // Strip any screen-reader role labels M365 prepends ("You said:",
    // "Copilot said: …Reasoning completed in N steps"), tidy whitespace, then
    // collapse the loose-list blank lines M365 emits between bullets.
    cleanTurn(role, md) {
      const stripped = (md || "")
        .replace(/^\s*(You said:|Copilot said:)\s*/i, "")
        .replace(/^\s*Copilot Reasoning completed in \d+ steps?\s*/i, "");
      return tightenLists(tidyWhitespace(stripped));
    },

    title() {
      return clean(
        document.title.replace(/\s*[-|]\s*(Microsoft\s*(365\s*)?)?Copilot.*/i, "")
      );
    },

    model() {
      return "Microsoft 365 Copilot";
    }
  },

  // ---------------------------------------------------------------------------
  // Microsoft Copilot (consumer copilot.microsoft.com)
  // ---------------------------------------------------------------------------
  {
    id: "copilot",
    label: "Copilot",
    match: (host) => host === "copilot.microsoft.com",

    ROOT_SELECTORS: [
      // TUNE: Copilot's message list wrapper.
      'div[data-testid="chat-messages"]',
      'div[role="log"]',
      "main"
    ],

    USER_SELECTORS: [
      'div[data-content="user-message"]',
      '[data-testid="userMessage"]'
    ],
    ASSISTANT_SELECTORS: [
      'div[data-content="ai-message"]',
      '[data-testid="botMessage"]'
    ],

    SCROLL_SELECTORS: [
      'div[data-testid="chat-messages"]',
      'div[role="log"]'
    ],

    root() {
      return firstMatch(this.ROOT_SELECTORS);
    },

    turns() {
      return unionTurns(this.USER_SELECTORS, this.ASSISTANT_SELECTORS);
    },

    title() {
      return clean(document.title.replace(/\s*[-|]\s*(Microsoft\s*)?Copilot.*/i, ""));
    },

    model() {
      return "Microsoft Copilot";
    }
  }
];

// --- tiny helpers -----------------------------------------------------------
function firstMatch(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function clean(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

// Match user and assistant selectors INDEPENDENTLY, tag each element's role,
// drop any element nested inside another matched element (keep the outermost
// message container), then order by document position. Returns [{role, el}]
// or null if nothing matched at all.
function unionTurns(userSels, asstSels) {
  const found = [];
  (userSels || []).forEach((sel) =>
    document.querySelectorAll(sel).forEach((el) => found.push({ el, role: "user" }))
  );
  (asstSels || []).forEach((sel) =>
    document.querySelectorAll(sel).forEach((el) => found.push({ el, role: "assistant" }))
  );
  if (!found.length) return null;

  // Collapse the same element matched by multiple selectors.
  const seen = new Set();
  const uniq = [];
  for (const f of found) {
    if (seen.has(f.el)) continue;
    seen.add(f.el);
    uniq.push(f);
  }

  // Keep only outermost containers (drop any el contained by another matched el).
  const outer = uniq.filter(
    (f) => !uniq.some((g) => g.el !== f.el && g.el.contains(f.el))
  );

  // Order top-to-bottom by document position.
  outer.sort((a, b) => {
    if (a.el === b.el) return 0;
    const pos = a.el.compareDocumentPosition(b.el);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });

  return outer.map((f) => ({ role: f.role, el: f.el }));
}

function pickAdapter() {
  const host = location.hostname;
  return ADAPTERS.find((a) => a.match(host)) || null;
}

// Lowest common ancestor of two elements.
function lca(a, b) {
  const anc = new Set();
  let x = a;
  while (x) { anc.add(x); x = x.parentElement; }
  let y = b;
  while (y && !anc.has(y)) y = y.parentElement;
  return y || null;
}

// Lowest common ancestor of a list of elements.
function commonAncestor(els) {
  return els.reduce((acc, el) => (acc ? lca(acc, el) : el), null);
}

// Claude: derive turns structurally. `stream` is the container holding every
// turn (computed from the user-message anchors). Its direct children are the
// turn rows: a row containing a user-message is a user turn; any other row with
// real text is an assistant turn. No assistant selector required.
function claudeStructuralTurns(stream, asstAnchorSelectors) {
  if (!stream) return null;
  const out = [];

  for (const child of Array.from(stream.children)) {
    const userEl = child.querySelector('[data-testid="user-message"]');
    if (userEl || (child.matches && child.matches('[data-testid="user-message"]'))) {
      out.push({ role: "user", el: userEl || child });
      continue;
    }
    // textContent (not innerText): Claude wraps each turn in a
    // `[content-visibility:auto]` row, which zeroes innerText for off-screen
    // rows and made assistant turns vanish until scrolled into view. textContent
    // is populated regardless of render state.
    const txt = (child.textContent || "").replace(/\s+/g, " ").trim();
    if (txt.length > 1) out.push({ role: "assistant", el: child });
  }

  // Backup: if no assistant rows were found as direct children, anchor on the
  // assistant-only action buttons and climb to their row under `stream`.
  if (!out.some((t) => t.role === "assistant") && asstAnchorSelectors) {
    document.querySelectorAll(asstAnchorSelectors.join(", ")).forEach((a) => {
      let cur = a;
      while (cur && cur.parentElement && cur.parentElement !== stream) {
        cur = cur.parentElement;
      }
      if (cur && cur.parentElement === stream && !out.some((t) => t.el === cur)) {
        out.push({ role: "assistant", el: cur });
      }
    });
  }

  if (!out.length) return null;
  out.sort((a, b) => {
    if (a.el === b.el) return 0;
    const pos = a.el.compareDocumentPosition(b.el);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
  return out;
}
