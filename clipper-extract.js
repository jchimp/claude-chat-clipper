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

  // 55% (not 80%) of a viewport per step so consecutive windows OVERLAP.
  // Virtualized lists (M365's MessageListContainer) unmount rows once they
  // leave the viewport; with a wider step a row could mount and unmount
  // entirely between two harvest points and be lost from the clip.
  const step = Math.max(300, Math.floor((scroller.clientHeight || 700) * 0.55));

  let turnsError = null; // last adapter.turns() throw — reported, not swallowed

  const harvest = () => {
    let turns = null;
    try {
      turns = adapter.turns ? adapter.turns() : null;
    } catch (e) {
      // A throwing selector must not kill the harvest loop, but it must also
      // not masquerade as "empty chat" — record it for the failure report.
      turnsError = e;
      turns = null;
    }
    if (!turns || !turns.length) return;
    for (const t of turns) {
      // One turn whose HTML trips up the converter (an unexpected node shape,
      // a bad prune selector, etc.) must not abort the whole harvest — skip it
      // and keep going so the rest of the conversation still gets clipped.
      try {
        const sig = turnSig(t.role, t.el);
        if (collected.has(sig)) continue;
        const rect = t.el.getBoundingClientRect();
        const absY = rect.top + scroller.scrollTop;
        let md = htmlToMarkdown(pruneForConversion(adapter, t.el));
        if (adapter.cleanTurn) md = adapter.cleanTurn(t.role, md);
        if (md && md.trim()) collected.set(sig, { absY, role: t.role, md });
      } catch (e) {
        console.warn("[Obsidian Chat Clipper] skipped a turn that failed to convert", e, t);
      }
    }
  };

  // Harvest on DOM churn too, not just at scroll settle points. Virtualized
  // lists mount/unmount rows while content is scrolling — a row that appears
  // and disappears between two 300ms settle points would otherwise never be
  // harvested. Debounced so a burst of mutations costs one harvest, and the
  // dedup Map makes redundant harvests free.
  let mutTimer = null;
  const observer = new MutationObserver(() => {
    if (mutTimer) return;
    mutTimer = setTimeout(() => {
      mutTimer = null;
      harvest();
    }, 50);
  });
  try {
    observer.observe(scroller, { childList: true, subtree: true });
    if (root && root !== scroller && !scroller.contains(root)) {
      observer.observe(root, { childList: true, subtree: true });
    }
  } catch (e) {
    // Observation is an optimization; scrolling harvest still runs without it.
  }

  let steps = 0;
  try {
    // Settle at the very top first. Some lazily-loaded lists (e.g. M365 Copilot)
    // fetch older messages as you scroll up, growing scrollHeight; without this,
    // the earliest turns can be missing from the harvest. Keep re-touching the
    // top until scrollHeight stops growing (or a safety cap is hit).
    scroller.scrollTop = 0;
    await SLEEP(STEP_DELAY);
    for (let i = 0; i < 15; i++) {
      const hBefore = scroller.scrollHeight;
      scroller.scrollTop = 0;
      await SLEEP(STEP_DELAY);
      if (scroller.scrollHeight <= hBefore + 1) break;
    }
    harvest();

    let stableBottom = 0; // consecutive steps confirmed at a non-growing bottom
    let stall = 0;        // consecutive steps with no movement AND no growth
    const MAX_STALL = 10; // a slow lazy-load fetch shouldn't end the clip early
    while (steps < MAX_STEPS) {
      const before = scroller.scrollTop;
      const beforeHeight = scroller.scrollHeight;
      scroller.scrollTop = before + step;
      await SLEEP(STEP_DELAY);
      harvest();

      const grew = scroller.scrollHeight > beforeHeight + 1;
      const moved = scroller.scrollTop > before + 1;
      const atBottom =
        scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 4;

      if (grew || moved) {
        // Still making real progress (advanced, or more content just loaded) —
        // this is not "done", even if we also happen to read as at-bottom this
        // step (more may load once we're there).
        stall = 0;
        stableBottom = 0;
      } else if (atBottom) {
        // Truly stuck at an unchanging bottom: confirm a couple of times (lets
        // a final lazy chunk render) before declaring the conversation done.
        stall = 0;
        stableBottom += 1;
        if (stableBottom >= 2) break;
      } else {
        // No movement, no growth, not at bottom — a stall mid-conversation
        // (e.g. a slow fetch). Don't treat this as done; only bail out after a
        // long run of these so a genuinely stuck page can't loop forever.
        stableBottom = 0;
        stall += 1;
        if (stall >= MAX_STALL) break;
      }
      steps += 1;
    }

    // One final harvest at the very bottom.
    await SLEEP(STEP_DELAY);
    harvest();
  } finally {
    observer.disconnect();
    if (mutTimer) clearTimeout(mutTimer);
  }

  // Restore the user's scroll position (best effort).
  try { scroller.scrollTop = startTop; } catch (e) {}

  // Order by captured vertical position (top of conversation -> bottom), then
  // collapse lazy-render duplicates of the same turn.
  const sorted = Array.from(collected.values()).sort((a, b) => a.absY - b.absY);
  const ordered = dedupeAdjacent(sorted);
  return { ordered, scrollerFound: !!scroller, steps, turnsError };
}

window.__clipExtract = async function () {
  try {
    return await __clipExtractInner();
  } catch (e) {
    // A throw here used to reject the whole injected function, so Chrome
    // handed the popup an undefined result and it could only show the
    // generic "Could not read this page." Surface the real error instead.
    return { ok: false, error: "Unexpected error: " + ((e && (e.stack || e.message)) || e) };
  }
};

// Attach diagnostics to failed/degraded results so the popup can hand the
// user (or Claude) everything needed to fix a stale selector in one paste.
function withDiag(result) {
  const degraded =
    !result.ok ||
    (result.stats && (result.stats.mode === "generic" || result.stats.mode === "whole-root"));
  if (!degraded) return result;
  try {
    result.diag = clipDiagCompute();
  } catch (e) {
    // Diagnostics are best-effort; never let them break the result itself.
  }
  return result;
}

function errText(e) {
  return (e && (e.stack || e.message)) || String(e);
}

async function __clipExtractInner() {
  const adapter = pickAdapter();
  if (!adapter) {
    return withDiag({ ok: false, error: "No adapter matches " + location.hostname });
  }

  const url = location.href;
  const title = (adapter.title && adapter.title()) || document.title;
  const model = (adapter.model && adapter.model()) || "";

  // Does this page expose per-turn selectors at all? A throw here is a real
  // signal (broken selector), distinct from "no matches" — keep it.
  let probe = null;
  let probeError = null;
  try {
    probe = adapter.turns ? adapter.turns() : null;
  } catch (e) {
    probeError = e;
    probe = null;
  }

  // The adapter's own turn detection found nothing. Before giving up on
  // role-splitting, retry the scroll+harvest with the generic structural
  // detector (adapters.js) — degraded but still labelled You/Assistant.
  let mode = "adapter";
  let effective = adapter;
  if ((!probe || !probe.length) && typeof genericTurns === "function") {
    let gen = null;
    try {
      gen = genericTurns(adapter.root ? adapter.root() : document.body);
    } catch (e) { gen = null; }
    if (gen && gen.length) {
      mode = "generic";
      // Delegate everything (root, PRUNE_SELECTORS, cleanTurn…) to the real
      // adapter; only turn detection is swapped out.
      effective = Object.create(adapter);
      effective.turns = () =>
        genericTurns(adapter.root ? adapter.root() : document.body);
      probe = gen;
    }
  }

  if (probe && probe.length) {
    // --- Preferred path: scroll + harvest per-turn ---------------------------
    const { ordered, steps, turnsError } = await collectByScrolling(effective);

    if (!ordered.length) {
      return withDiag({
        ok: false,
        error:
          "Scrolled but harvested 0 turns — check the adapter selectors." +
          (turnsError ? "\nturns() threw: " + errText(turnsError) : ""),
      });
    }

    const body = ordered
      .map((t) => {
        const heading = t.role === "user" ? "## 🧑 You" : "## 🤖 Assistant";
        return `${heading}\n\n${t.md}`;
      })
      .join("\n\n");

    // Collapse any blank-line bloat reintroduced by the per-turn join.
    const tidyBody = typeof tidyWhitespace === "function" ? tidyWhitespace(body) : body.trim();

    return withDiag({
      ok: true,
      site: adapter.label,
      title: title || adapter.label + " chat",
      model,
      url,
      turns: ordered.map((t) => ({ role: t.role, md: t.md })),
      body: tidyBody,
      stats: { turns: ordered.length, scrollSteps: steps, mode },
    });
  }

  // --- Fallback path: no turn selectors. Scroll to force-render, then dump root.
  const root = adapter.root ? adapter.root() : null;
  if (!root) {
    return withDiag({
      ok: false,
      error:
        "Could not find the conversation root. Open DevTools and run __clipDiag(), then tune ROOT_SELECTORS in adapters.js." +
        (probeError ? "\nturns() threw: " + errText(probeError) : ""),
    });
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

  return withDiag({
    ok: true,
    site: adapter.label,
    title: title || adapter.label + " chat",
    model,
    url,
    turns: [],
    body: body.trim(),
    stats: { turns: 0, mode: "whole-root" },
  });
}

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
  let turnsThrew = "";
  try {
    const t = adapter.turns ? adapter.turns() : null;
    if (t) {
      userTurns = t.filter((x) => x.role === "user").length;
      assistantTurns = t.filter((x) => x.role === "assistant").length;
    }
  } catch (e) {
    turnsThrew = errText(e);
  }

  // What would the generic structural fallback see? Helps judge whether a
  // degraded clip is available even when the adapter's selectors are stale.
  let genericCounts = "";
  try {
    if (typeof genericTurns === "function") {
      const g = genericTurns((adapter.root && adapter.root()) || document.body);
      if (g) {
        genericCounts =
          g.filter((x) => x.role === "user").length + " user / " +
          g.filter((x) => x.role === "assistant").length + " assistant";
      }
    }
  } catch (e) {}

  // Report the scroll container the extractor would actually use, plus a sample
  // turn-row's outer HTML — the two things a future Claude redesign needs.
  let scrollInfo = "(none)";
  let sampleTurn = "(none)";
  const root = (adapter.root && adapter.root()) || document.body;
  try {
    const scroller = findScrollContainer(adapter, root);
    if (scroller && scroller.tagName) {
      const cls = String(scroller.className || "").trim().split(/\s+/).filter(Boolean).join(".");
      scrollInfo =
        scroller.tagName.toLowerCase() + (cls ? "." + cls : "") +
        ` (scrollH=${scroller.scrollHeight}, clientH=${scroller.clientHeight})`;
    }
    let turns = null;
    try { turns = adapter.turns ? adapter.turns() : null; } catch (e) {}
    if (turns && turns.length && turns[0].el) {
      sampleTurn = (turns[0].el.outerHTML || "").slice(0, 400);
    }
  } catch (e) {}

  let topClasses = [];
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
    turnsThrew,
    genericCounts,
    testids,
    topClasses,
    scrollInfo,
    sampleTurn,
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
