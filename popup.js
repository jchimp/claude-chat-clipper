// popup.js — toolbar UI. Injects the page bundle, calls window.__clipClaude(),
// and hands the result to the clipboard or the Downloads folder.
const $ = (id) => document.getElementById(id);

// Dependency order matters: clip.js calls into everything before it.
const PAGE_FILES = ["html2md.js", "transcript.js", "dom-fallback.js", "api.js", "chatgpt.js", "clip.js"];

let lastError = "";

// Must match PROVIDERS in clip.js and host_permissions in manifest.json.
function isSupportedUrl(url) {
  try {
    const host = new URL(url).hostname;
    return (
      host === "claude.ai" || host.endsWith(".claude.ai") ||
      host === "chatgpt.com" || host.endsWith(".chatgpt.com") ||
      host === "chat.openai.com"
    );
  } catch {
    return false;
  }
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function setStatus(msg, kind = "") {
  const el = $("status");
  el.textContent = msg;
  el.className = "status " + kind;
}

function showError(msg) {
  lastError = msg;
  $("copyErr").hidden = false;
  setStatus(msg, "err");
}

async function extract(tabId) {
  // Inject once per page load. Every page file is an IIFE writing into
  // window.__claudeClipper, so a re-inject would be harmless but wasteful.
  const [{ result: ready }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => typeof window.__clipClaude === "function",
  });
  if (!ready) {
    await chrome.scripting.executeScript({ target: { tabId }, files: PAGE_FILES });
  }
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.__clipClaude(),
  });
  return result;
}

function summary(data) {
  const n = data.transcript.turns.length;
  const src = data.transcript.source === "api" ? "" : ` via ${data.transcript.source}`;
  return `${n} turns${src}`;
}

async function run(tab, action) {
  $("copyErr").hidden = true;
  setStatus("Fetching conversation…");
  try {
    const data = await extract(tab.id);
    if (!data) throw new Error("No result from page (is the tab still loading?).");
    if (!data.ok) throw new Error(data.error || "Could not read this conversation.");
    const done = await action(data);
    setStatus(`${done} (${summary(data)}).${data.warning ? " " + data.warning : ""}`, data.warning ? "warn" : "ok");
  } catch (err) {
    showError("Error: " + (err && err.message ? err.message : String(err)));
  }
}

async function init() {
  const tab = await activeTab();
  try {
    $("site").textContent = new URL(tab.url).hostname;
  } catch {
    $("site").textContent = "";
  }

  if (!isSupportedUrl(tab && tab.url)) {
    ["copyMd", "copyJson", "download"].forEach((id) => { $(id).disabled = true; });
    setStatus("Open a claude.ai or ChatGPT conversation to clip it.");
    return;
  }

  $("copyMd").addEventListener("click", () =>
    run(tab, async (data) => {
      await navigator.clipboard.writeText(data.markdown);
      return "Markdown copied";
    })
  );

  $("copyJson").addEventListener("click", () =>
    run(tab, async (data) => {
      await navigator.clipboard.writeText(JSON.stringify(data.transcript, null, 2));
      return "JSON copied";
    })
  );

  $("download").addEventListener("click", () =>
    run(tab, async (data) => {
      // data: URL rather than a blob URL so nothing has to be revoked after
      // the popup closes.
      const url = "data:text/markdown;charset=utf-8," + encodeURIComponent(data.markdown);
      await chrome.downloads.download({ url, filename: data.filename, saveAs: false });
      return "Saved to Downloads/" + data.filename;
    })
  );

  $("copyErr").addEventListener("click", async () => {
    await navigator.clipboard.writeText(`Claude Chat Clipper\nURL: ${tab.url}\n${lastError}`);
    setStatus("Error details copied.", "ok");
  });
}

init();
