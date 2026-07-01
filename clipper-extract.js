// =============================================================================
// clipper-extract.js — runs IN THE PAGE. Uses pickAdapter() (adapters.js) and
// htmlToMarkdown() (html2md.js). Exposes:
//   window.__clipExtract()  -> Promise<{ ok, site, title, model, url, turns[], body, stats }>
//   window.__clipDiag()     -> prints what the adapter currently matches
//
// Claude (and Copilot) mount messages lazily: only what's near the viewport is
// in the DOM. So we SCROLL the conversation top -> bottom and harvest each turn
// to Markdown WHILE IT IS LIVE, accumulating as we go. Reading the DOM once at
// the top only ever sees the top — which was your bug.
// =============================================================================

const SLEEP = (ms) => new Promise((r) => setTimeout(r, ms));

// Collapsed-text signature so the same turn captured on two scroll steps is
// de-duplicated. role is included so an identical user/assistant line is kept.
function turnSig(role, el) {
  const t = (el.innerText || el.textContent || "").replace(/\s+/g, " ").trim();
  return role + "::" + t.length + "::" + t.slice(0, 160) + "::" + t.slice(-60);
}

// Drop an adjacent same-role turn whose text duplicates its neighbor — fixes the
// lazy-render case where a turn is harvested both partially and fully (the sigs
// differ, so the Map keeps both). Only collapses neighbors of the same role when
// one's normalized text contains the other's; keeps the longer (more complete).
function dedupeAdjacent(ordered) {
  const norm = (s) => (s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const out = [];
  for (const t of ordered) {
    const prev = out[out.length - 1];
    if (prev && prev.role === t.role) {
      const a = norm(prev.md);
      const b = norm(t.md);
      if (a && b && (a.includes(b) || b.includes(a))) {
        if (b.length > a.length) out[out.length - 1] = t; // keep the longer one
        continue;
      }
    }
    out.push(t);
  }
  return out;
}

// Return an element to convert, with the adapter's chrome nodes (tool-use chips,
// artifact cards) removed. Clones first so the live page is never mutated.
function pruneForConversion(adapter, el) {
  const sels = adapter.PRUNE_SELECTORS;
  if (!sels || !sels.length) return el;
  const clone = el.cloneNode(true);
  clone.querySelectorAll(sels.join(", ")).forEach((n) => n.remove());
  return clone;
}

// Find the scrollable element holding the conversation.
function findScrollContainer(adapter, root) {
  if (adapter.SCROLL_SELECTORS) {
    for (const sel of adapter.SCROLL_SELECTORS) {
      const el = document.querySelector(sel);
      if (el && el.scrollHeight > el.clientHeight + 8) return el;
    }
  }
  // Walk up from the conversation root to the nearest scrollable ancestor.
  let el = root;
  while (el && el !== document.body) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 8) {
      return el;
    }
    el = el.parentElement;
  }
  return document.scrollingElement || document.documentElement;
}

// Scroll the whole conversation and harvest turns to Markdown along the way.
async function collectByScrolling(adapter) {
  const root = adapter.root ? adapter.root() : document.body;
  const scroller = findScrollContainer(adapter, root);

  const startTop = scroller.scrollTop;
  const collected = new Map(); // sig -> { absY, role, md }
  const STEP_DELAY = 300;      // ms to let lazy content render after each scroll
  const MAX_STEPS = 600;       // hard safety cap

  const step = Math.max(300, Math.floor((scroller.clientHeight || 700) * 0.8));

  const harvest = () => {
    let turns = null;
    try { turns = adapter.turns ? adapter.turns() : null; } catch (e) { turns = null; }
    if (!turns || !turns.length) return;
    for (const t of turns) {
      const sig = turnSig(t.role, t.el);
      if (collected.has(sig)) continue;
      const rect = t.el.getBoundingClientRect();
      const absY = rect.top + scroller.scrollTop;
      let md = htmlToMarkdown(pruneForConversion(adapter, t.el));
      if (adapter.cleanTurn) md = adapter.cleanTurn(t.role, md);
      if (md && md.trim()) collected.set(sig, { absY, role: t.role, md });
    }
  };

  // Start at the very top and walk down, harvesting at each settle point.
  scroller.scrollTop = 0;
  await SLEEP(STEP_DELAY);
  harvest();

  let steps = 0;
  let stableBottom = 0;
  while (steps < MAX_STEPS) {
    const before = scroller.scrollTop;
    scroller.scrollTop = before + step;
    await SLEEP(STEP_DELAY);
    harvest();

    const atBottom =
      scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;
    const didntMove = scroller.scrollTop <= before + 1;

    if (atBottom || didntMove) {
      stableBottom += 1;
      // Two confirmations at the bottom (lets a final lazy chunk render).
      if (stableBottom >= 2) break;
    } else {
      stableBottom = 0;
    }
    steps += 1;
  }

  // One final harvest at the very bottom.
  await SLEEP(STEP_DELAY);
  harvest();

  // Restore the user's scroll position (best effort).
  try { scroller.scrollTop = startTop; } catch (e) {}

  // Order by captured vertical position (top of conversation -> bottom), then
  // collapse lazy-render duplicates of the same turn.
  const sorted = Array.from(collected.values()).sort((a, b) => a.absY - b.absY);
  const ordered = dedupeAdjacent(sorted);
  return { ordered, scrollerFound: !!scroller, steps };
}

window.__clipExtract = async function () {
  const adapter = pickAdapter();
  if (!adapter) {
    return { ok: false, error: "No adapter matches " + location.hostname };
  }

  const url = location.href;
  const title = (adapter.title && adapter.title()) || document.title;
  const model = (adapter.model && adapter.model()) || "";

  // Does this page expose per-turn selectors at all?
  let probe = null;
  try { probe = adapter.turns ? adapter.turns() : null; } catch (e) { probe = null; }

  if (probe && probe.length) {
    // --- Preferred path: scroll + harvest per-turn ---------------------------
    const { ordered, steps } = await collectByScrolling(adapter);

    if (!ordered.length) {
      return { ok: false, error: "Scrolled but harvested 0 turns — check TURN_SELECTORS." };
    }

    const body = ordered
      .map((t) => {
        const heading = t.role === "user" ? "## 🧑 You" : "## 🤖 Assistant";
        return `${heading}\n\n${t.md}`;
      })
      .join("\n\n");

    // Collapse any blank-line bloat reintroduced by the per-turn join.
    const tidyBody = typeof tidyWhitespace === "function" ? tidyWhitespace(body) : body.trim();

    return {
      ok: true,
      site: adapter.label,
      title: title || adapter.label + " chat",
      model,
      url,
      turns: ordered.map((t) => ({ role: t.role, md: t.md })),
      body: tidyBody,
      stats: { turns: ordered.length, scrollSteps: steps },
    };
  }

  // --- Fallback path: no turn selectors. Scroll to force-render, then dump root.
  const root = adapter.root ? adapter.root() : null;
  if (!root) {
    return {
      ok: false,
      error:
        "Could not find the conversation root. Open DevTools and run __clipDiag(), then tune ROOT_SELECTORS in adapters.js.",
    };
  }
  // Force lazy content to render even without per-turn keys.
  const scroller = findScrollContainer(adapter, root);
  const startTop = scroller.scrollTop;
  for (let i = 0; i < 400; i++) {
    const before = scroller.scrollTop;
    scroller.scrollTop = before + Math.max(300, (scroller.clientHeight || 700) * 0.8);
    await SLEEP(250);
    if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4) break;
    if (scroller.scrollTop <= before + 1) break;
  }
  await SLEEP(250);
  const body = htmlToMarkdown(root);
  try { scroller.scrollTop = startTop; } catch (e) {}

  return {
    ok: true,
    site: adapter.label,
    title: title || adapter.label + " chat",
    model,
    url,
    turns: [],
    body: body.trim(),
    stats: { turns: 0, mode: "whole-root" },
  };
};

function clipDiagCompute() {
  const adapter = pickAdapter();
  if (!adapter) {
    return { ok: false, host: location.hostname, error: "No adapter matches this site." };
  }

  const matchList = (sels) =>
    (sels || []).map((sel) => ({ sel, matched: !!document.querySelector(sel) }));

  const countSet = (sels) => {
    const s = new Set();
    (sels || []).forEach((sel) =>
      document.querySelectorAll(sel).forEach((el) => s.add(el))
    );
    return s.size;
  };

  const testids = [
    ...new Set(
      [...document.querySelectorAll("[data-testid]")].map((e) =>
        e.getAttribute("data-testid")
      )
    ),
  ].sort();

  // Count roles from the adapter's real turn detection (works whether the
  // adapter uses selectors or structural detection).
  let userTurns = 0;
  let assistantTurns = 0;
  try {
    const t = adapter.turns ? adapter.turns() : null;
    if (t) {
      userTurns = t.filter((x) => x.role === "user").length;
      assistantTurns = t.filter((x) => x.role === "assistant").length;
    }
  } catch (e) {}

  let topClasses = [];
  const root = (adapter.root && adapter.root()) || document.body;
  if (root) {
    const freq = {};
    root.querySelectorAll("div[class]").forEach((el) => {
      el.className.toString().split(/\s+/).forEach((c) => {
        if (c) freq[c] = (freq[c] || 0) + 1;
      });
    });
    topClasses = Object.entries(freq)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 30)
      .map(([c, n]) => `${c} (${n})`);
  }

  return {
    ok: true,
    host: location.hostname,
    adapter: adapter.id,
    root: matchList(adapter.ROOT_SELECTORS),
    scroll: matchList(adapter.SCROLL_SELECTORS),
    userMatched: userTurns,
    assistantMatched: assistantTurns,
    testids,
    topClasses,
    title: adapter.title ? adapter.title() : "",
  };
}

// Returns the diagnostics object (used by the popup's Diagnose button).
window.__clipDiagData = function () {
  return clipDiagCompute();
};

// Console version (for power users who switch the console's context).
window.__clipDiag = function () {
  console.log("[Obsidian Chat Clipper] diagnostics", clipDiagCompute());
};
