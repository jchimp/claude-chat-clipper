// =============================================================================
// note.js — turns an extraction result + your settings into the final .md.
// This is where your "notes at the top + highlight important things" workflow
// is baked in, so every clip starts pre-scaffolded.
// =============================================================================

function buildNote(data, settings) {
  const now = new Date();
  const iso = now.toISOString();
  const dateStr = iso.slice(0, 10);

  const tags = (settings.tags || "ai/chat")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);

  const fm = [
    "---",
    `title: "${escYaml(data.title)}"`,
    `source: ${data.site}`,
    `model: "${escYaml(data.model || "")}"`,
    `url: ${data.url}`,
    `created: ${iso}`,
    `tags: [${tags.map((t) => `${t}`).join(", ")}]`,
    "---",
    ""
  ].join("\n");

  const notesBlock = [
    `# ${data.title}`,
    "",
    "> [!note] My notes",
    "> _Why I saved this / key takeaways:_",
    "> - ",
    "",
    "## ⭐ Highlights",
    "- ",
    "",
    "---",
    "",
    "## Transcript",
    ""
  ].join("\n");

  return fm + notesBlock + data.body + "\n";
}

function buildFilename(data, settings) {
  const pattern = settings.filenamePattern || "{date} {title}";
  const dateStr = new Date().toISOString().slice(0, 10);
  const safeTitle = (data.title || "chat")
    .replace(/[\\/:*?"<>|]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  const name = pattern
    .replace("{date}", dateStr)
    .replace("{site}", data.site)
    .replace("{title}", safeTitle);
  return name.replace(/[\\/:*?"<>|]+/g, "").trim() + ".md";
}

function escYaml(s) {
  return (s || "").replace(/"/g, '\\"');
}
