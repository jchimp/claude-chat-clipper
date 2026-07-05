// =============================================================================
// normalize.js — Claude-only Markdown tidy-up. Runs IN THE PAGE, after a turn
// has been converted by htmlToMarkdown(). Strips Claude's UI chrome (the
// "Claude responded:" preview heading + the collapsed thinking-summary line)
// and normalizes whitespace so clips read cleanly in Obsidian.
//
// Scoped to Claude via the adapter's optional cleanTurn() hook — other sites
// never call this, so their output is untouched.
// =============================================================================

// Collapse whitespace-only lines and runs of blank lines. The lone-space lines
// Claude emits between paragraphs (`\n\n \n\n`) survive html2md's \n{3,} collapse
// because the space breaks the newline run — blank them out first, then collapse.
function tidyWhitespace(md) {
  return (md || "")
    .replace(/^[^\S\n]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Collapse the blank line between consecutive list items (M365 Copilot renders
// "loose" lists, so every bullet and its sub-bullets are separated by a blank
// line). Only drops a blank line when BOTH the line before and the line after it
// are list items, so paragraphs, code fences, and headings keep their spacing.
function tightenLists(md) {
  const lines = (md || "").split("\n");
  const isItem = (l) => /^\s*([-*+]|\d+\.)\s/.test(l);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "") {
      const prev = out.length ? out[out.length - 1] : "";
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === "") j++;
      const next = j < lines.length ? lines[j] : "";
      if (isItem(prev) && isItem(next)) continue; // drop blank between items
    }
    out.push(lines[i]);
  }
  return out.join("\n");
}

// Strip markdown emphasis/code formatting and collapse whitespace, for comparing
// the heading's preview text against the body's real first sentence.
function normForCompare(s) {
  return (s || "")
    .replace(/[`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

// Remove the two Claude assistant artifacts that sit above the real reply:
//   1. a leading "## Claude responded: <first sentence>" heading, and
//   2. the collapsed thinking-summary line(s) between it and the real content.
// Both are anchored off real data: the heading is a preview of the reply's first
// sentence, so we drop everything from the heading up to where that sentence
// actually reappears. If the sentence never reappears we drop nothing, so we
// can never eat real content.
function stripClaudeChrome(md) {
  const headingRe = /^#{1,6}\s+Claude (?:responded|said):\s*(.*)$/m;
  const m = (md || "").match(headingRe);
  if (!m) return md;

  const snorm = normForCompare(m[1]);
  // Remainder after the heading line.
  const rest = md.slice(m.index + m[0].length).replace(/^\n+/, "");
  if (!snorm) return rest; // empty preview: just drop the heading.

  const blocks = rest.split(/\n{2,}/);
  const MAX_LEADING = 3; // thinking summaries are 1 short line; cap defensively.
  let keepFrom = -1;
  for (let i = 0; i < blocks.length && i < MAX_LEADING; i++) {
    if (normForCompare(blocks[i]).startsWith(snorm)) {
      keepFrom = i;
      break;
    }
  }
  if (keepFrom < 0) return rest; // no match — abort the drop, keep all content.
  return blocks.slice(keepFrom).join("\n\n");
}

// Per-turn entry point used by the Claude adapter's cleanTurn() hook.
function normalizeClaudeTurn(role, md) {
  const cleaned = role === "assistant" ? stripClaudeChrome(md) : md;
  return tidyWhitespace(cleaned);
}
