// popup.js
const $ = (id) => document.getElementById(id);

const DEFAULT_SETTINGS = {
  tags: "ai/chat",
  filenamePattern: "{date} {title}",
};

async function getSettings() {
  const s = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(s.settings || {}) };
}

// Mirrors manifest.json host_permissions — the only hosts we can actually
// inject into / have an adapter for. Guarding here avoids attempting
// injection on privileged pages (chrome://, the extensions gallery, etc.),
// which throws "The extensions gallery cannot be scripted."
const SUPPORTED_HOSTS = [
  /(^|\.)claude\.ai$/,
  /^copilot\.microsoft\.com$/,
  /(^|\.)cloud\.microsoft$/,
];
function isSupportedUrl(url) {
  try {
    return SUPPORTED_HOSTS.some((re) => re.test(new URL(url).hostname));
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

function formatDiag(d, url) {
  if (!d) return "Diagnostics: (no data returned)";
  if (!d.ok) {
    return [
      "Obsidian Chat Clipper diagnostics",
      "URL: " + url,
      "host: " + d.host,
      "ERROR: " + (d.error || "unknown"),
    ].join("\n");
  }
  const lines = [
    "Obsidian Chat Clipper diagnostics",
    "URL: " + url,
    "host: " + d.host,
    "adapter: " + d.adapter,
    "title guess: " + (d.title || "(none)"),
    "",
    "user turns matched: " + d.userMatched,
    "assistant turns matched: " + d.assistantMatched,
    "",
    "ROOT selectors:",
    ...d.root.map((r) => `  [${r.matched ? "MATCH" : "  -  "}] ${r.sel}`),
    "",
    "SCROLL selectors:",
    ...d.scroll.map((r) => `  [${r.matched ? "MATCH" : "  -  "}] ${r.sel}`),
    "",
    "scroll container in use:",
    "  " + (d.scrollInfo || "(none)"),
    "",
    "sample turn outerHTML:",
    "  " + (d.sampleTurn || "(none)"),
    "",
    "all data-testid values on page:",
    "  " + (d.testids.length ? d.testids.join(", ") : "(none)"),
    "",
    "top class names inside root:",
    ...d.topClasses.map((c) => "  " + c),
  ];
  return lines.join("\n");
}

async function extract(tabId) {
  // Inject helpers only once per page load — re-running files with top-level
  // `const` declarations throws "already declared" on the 2nd click.
  const [{ result: ready }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => typeof window.__clipExtract === "function",
  });
  if (!ready) {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ["normalize.js", "adapters.js", "html2md.js", "clipper-extract.js"],
    });
  }
  // __clipExtract is async (it scrolls + harvests); executeScript awaits the
  // returned promise and hands back the resolved value.
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => window.__clipExtract(),
  });
  return result;
}

async function init() {
  const tab = await activeTab();
  try {
    const host = new URL(tab.url).hostname;
    $("site").textContent = host;
  } catch {
    $("site").textContent = "";
  }

  $("openOptions").addEventListener("click", (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });

  if (!isSupportedUrl(tab && tab.url)) {
    ["clip", "copy", "diag"].forEach((id) => {
      $(id).disabled = true;
    });
    setStatus("Open a Claude or Copilot chat to clip.", "");
    return;
  }

  $("diag").addEventListener("click", async () => {
    setStatus("Running diagnostics…");
    try {
      // Inject helpers once (same pattern as extract), then read diagnostics.
      const [{ result: ready }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => typeof window.__clipDiagData === "function",
      });
      if (!ready) {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ["normalize.js", "adapters.js", "html2md.js", "clipper-extract.js"],
        });
      }
      const [{ result: d }] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => window.__clipDiagData(),
      });

      const text = formatDiag(d, tab.url);
      await navigator.clipboard.writeText(text);
      if (d && d.ok) {
        setStatus(
          `Copied. user=${d.userMatched}, assistant=${d.assistantMatched}. Paste it to Claude.`,
          "ok"
        );
      } else {
        setStatus("Copied diagnostics to clipboard. Paste it to Claude.", "ok");
      }
    } catch (err) {
      setStatus("Error: " + err.message, "err");
    }
  });

  $("clip").addEventListener("click", async () => {
    try {
      // Ask for vault permission NOW, while the click is still "fresh". Doing
      // this before the multi-second scroll avoids the user-activation error.
      const handle = await getVaultHandle();
      if (handle && !(await hasPermission(handle))) {
        setStatus("Confirm folder access…");
        await requestPermissionNow(handle); // tolerated if it fails -> download
      }

      setStatus("Collecting full conversation (auto-scrolling)…");
      const data = await extract(tab.id);
      if (!data || !data.ok) {
        setStatus((data && data.error) || "Could not read this page.", "err");
        return;
      }
      const settings = await getSettings();
      const md = buildNote(data, settings);
      const filename = buildFilename(data, settings);
      const res = await writeNote(filename, md);
      const n = (data.stats && data.stats.turns) || 0;
      const got = n ? ` (${n} turns)` : " (whole-page mode)";
      if (res.method === "vault") {
        setStatus("Saved to vault: " + res.path + got, "ok");
      } else {
        setStatus(
          "Saved to " + res.path + got + " — re-grant the vault folder in Settings to save there directly.",
          "ok"
        );
      }
    } catch (err) {
      setStatus("Error: " + err.message, "err");
    }
  });

  $("copy").addEventListener("click", async () => {
    setStatus("Collecting full conversation (auto-scrolling)…");
    try {
      const data = await extract(tab.id);
      if (!data || !data.ok) {
        setStatus((data && data.error) || "Could not read this page.", "err");
        return;
      }
      const settings = await getSettings();
      const md = buildNote(data, settings);
      await navigator.clipboard.writeText(md);
      const n = (data.stats && data.stats.turns) || 0;
      setStatus("Copied to clipboard" + (n ? ` (${n} turns).` : "."), "ok");
    } catch (err) {
      setStatus("Error: " + err.message, "err");
    }
  });
}

init();
