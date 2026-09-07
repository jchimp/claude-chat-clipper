// =============================================================================
// html2md.js — small, dependency-free HTML -> Markdown converter.
// Only used by the DOM fallback (the API path already returns Markdown).
// Handles paragraphs, headings, bold/italic/code, fenced code blocks (with
// language), lists, links, blockquotes, hr, and simple tables.
// =============================================================================
(function () {
  const NS = (window.__claudeClipper = window.__claudeClipper || {});

  NS.htmlToMarkdown = function htmlToMarkdown(rootEl) {
    if (!rootEl) return "";
    return walk(rootEl).replace(/\n{3,}/g, "\n\n").trim();
  };

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
        if (node.closest("pre")) return inner();
        return "`" + text(node) + "`";
      case "pre": {
        const codeEl = node.querySelector("code");
        const lang = guessLang(codeEl || node);
        // textContent, not innerText: Claude renders turn rows with
        // `content-visibility: auto`, and innerText is empty for rows that are
        // off-screen. That produced blank code fences.
        const codeText = (codeEl || node).textContent.replace(/\n$/, "");
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
      ...matrix.slice(1).map((row) => `| ${row.join(" | ")} |`),
    ];
    return lines.join("\n");
  }
})();
