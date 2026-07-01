// =============================================================================
// html2md.js — small, dependency-free HTML -> Markdown converter.
// Handles the things that actually show up in AI chats: paragraphs, headings,
// bold/italic/code, fenced code blocks (with language), lists, links,
// blockquotes, hr, and simple tables. Good enough for notes; swap in Turndown
// later if you want pixel-perfect fidelity.
// =============================================================================

function htmlToMarkdown(rootEl) {
  if (!rootEl) return "";
  const out = walk(rootEl).replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

function walk(node) {
  let md = "";
  node.childNodes.forEach((child) => {
    md += render(child);
  });
  return md;
}

function render(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent.replace(/\s+/g, " ");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  // Microsoft 365 Copilot (Scriptor) code blocks have no <pre>/<code> — the
  // language label is the leading text and the code lines follow. Intercept
  // before the generic element handling so we can emit a real fence.
  if (node.classList && node.classList.contains("scriptor-component-code-block")) {
    return scriptorCodeBlock(node);
  }

  const tag = node.tagName.toLowerCase();
  const inner = () => walk(node);

  switch (tag) {
    case "script":
    case "style":
    case "svg":
    case "button":
      return "";
    case "h1": return `\n\n# ${text(node)}\n\n`;
    case "h2": return `\n\n## ${text(node)}\n\n`;
    case "h3": return `\n\n### ${text(node)}\n\n`;
    case "h4": return `\n\n#### ${text(node)}\n\n`;
    case "h5": return `\n\n##### ${text(node)}\n\n`;
    case "h6": return `\n\n###### ${text(node)}\n\n`;
    case "p": return `\n\n${inner().trim()}\n\n`;
    case "br": return "  \n";
    case "hr": return "\n\n---\n\n";
    case "strong":
    case "b": return `**${inner().trim()}**`;
    case "em":
    case "i": return `*${inner().trim()}*`;
    case "del":
    case "s": return `~~${inner().trim()}~~`;
    case "code":
      // inline code only if not inside a <pre> (pre handled below)
      if (node.closest("pre")) return inner();
      return "`" + text(node) + "`";
    case "pre": {
      const codeEl = node.querySelector("code");
      const lang = guessLang(codeEl || node);
      const codeText = (codeEl || node).innerText.replace(/\n$/, "");
      return `\n\n\`\`\`${lang}\n${codeText}\n\`\`\`\n\n`;
    }
    case "a": {
      const href = node.getAttribute("href") || "";
      const label = inner().trim() || href;
      return href ? `[${label}](${href})` : label;
    }
    case "ul": return `\n${list(node, false)}\n`;
    case "ol": return `\n${list(node, true)}\n`;
    case "blockquote":
      return "\n\n" + inner().trim().split("\n").map((l) => `> ${l}`).join("\n") + "\n\n";
    case "table": return `\n\n${table(node)}\n\n`;
    case "img": {
      const alt = node.getAttribute("alt") || "";
      const src = node.getAttribute("src") || "";
      return src ? `![${alt}](${src})` : "";
    }
    default:
      return inner();
  }
}

function text(node) {
  return node.textContent.replace(/\s+/g, " ").trim();
}

// Map M365 Copilot's code-block language label to a fence language token.
const SCRIPTOR_LANGS = {
  "plain text": "", plaintext: "", text: "",
  shell: "bash", bash: "bash", sh: "bash", zsh: "bash", console: "bash",
  powershell: "powershell", ps: "powershell", ps1: "powershell",
  python: "python", py: "python",
  json: "json", yaml: "yaml", yml: "yaml", toml: "toml", ini: "ini",
  javascript: "javascript", js: "javascript", jsx: "jsx",
  typescript: "typescript", ts: "typescript", tsx: "tsx",
  html: "html", xml: "xml", css: "css", scss: "scss", sql: "sql",
  "c#": "csharp", csharp: "csharp", "c++": "cpp", cpp: "cpp", c: "c",
  java: "java", kotlin: "kotlin", go: "go", golang: "go", rust: "rust",
  ruby: "ruby", php: "php", markdown: "markdown", md: "markdown",
  dockerfile: "dockerfile", diff: "diff"
};

// Convert a Scriptor code block (M365 Copilot) to Markdown. The language label
// is the leading text and glues to the first code line (e.g. "Pythonimport os"),
// so we strip the longest known label prefix and emit the rest as code. A
// single-line snippet becomes inline `code`; multi-line becomes a fenced block.
function scriptorCodeBlock(node) {
  let raw = (node.innerText || "").replace(/ /g, " ").replace(/^[ \t\r\n]+/, "");
  if (!raw) return "";

  let lang = "";
  const lower = raw.toLowerCase();
  for (const label of Object.keys(SCRIPTOR_LANGS).sort((a, b) => b.length - a.length)) {
    if (lower.startsWith(label)) {
      lang = SCRIPTOR_LANGS[label];
      raw = raw.slice(label.length);
      break;
    }
  }

  const code = raw
    .replace(/^[ \t]*\r?\n/, "")           // drop the separator after the label
    .split("\n")
    .map((l) => l.replace(/[ \t]+$/, "")) // Scriptor pads each line with spaces
    .join("\n")
    .replace(/\s+$/, "");
  if (!code) return "";
  if (!code.includes("\n")) return "`" + code + "`";
  return `\n\n\`\`\`${lang}\n${code}\n\`\`\`\n\n`;
}

function guessLang(el) {
  const cls = (el.getAttribute && el.getAttribute("class")) || "";
  const m = cls.match(/language-([a-z0-9+#]+)/i) || cls.match(/lang-([a-z0-9+#]+)/i);
  return m ? m[1] : "";
}

function list(node, ordered) {
  let i = 1;
  let out = "";
  node.childNodes.forEach((li) => {
    if (li.nodeType === Node.ELEMENT_NODE && li.tagName.toLowerCase() === "li") {
      const marker = ordered ? `${i++}. ` : "- ";
      const body = walk(li).trim().replace(/\n/g, "\n  ");
      out += `${marker}${body}\n`;
    }
  });
  return out;
}

function table(node) {
  const rows = Array.from(node.querySelectorAll("tr"));
  if (!rows.length) return "";
  const matrix = rows.map((r) =>
    Array.from(r.querySelectorAll("th,td")).map((c) => text(c).replace(/\|/g, "\\|"))
  );
  const header = matrix[0];
  const sep = header.map(() => "---");
  const lines = [
    `| ${header.join(" | ")} |`,
    `| ${sep.join(" | ")} |`,
    ...matrix.slice(1).map((row) => `| ${row.join(" | ")} |`)
  ];
  return lines.join("\n");
}
