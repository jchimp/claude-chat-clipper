// options.js
const $ = (id) => document.getElementById(id);

async function load() {
  const { settings } = await chrome.storage.local.get("settings");
  $("tags").value = (settings && settings.tags) || "ai/chat";
  $("pattern").value = (settings && settings.filenamePattern) || "{date} {title}";

  const handle = await getVaultHandle();
  if (handle) {
    const granted = (await handle.queryPermission({ mode: "readwrite" })) === "granted";
    $("vaultState").innerHTML = `Set: <code>${handle.name}</code>${granted ? "" : " (will re-ask permission on first clip)"}`;
    $("vaultState").className = "hint ok";
  }
}

$("pickVault").addEventListener("click", async () => {
  try {
    const handle = await window.showDirectoryPicker({ mode: "readwrite", id: "obsidian-vault" });
    const granted = (await handle.requestPermission({ mode: "readwrite" })) === "granted";
    if (!granted) {
      $("vaultState").textContent = "Permission denied.";
      $("vaultState").className = "hint err";
      return;
    }
    await saveVaultHandle(handle);
    $("vaultState").innerHTML = `Set: <code>${handle.name}</code>`;
    $("vaultState").className = "hint ok";
  } catch (e) {
    if (e.name !== "AbortError") {
      $("vaultState").textContent = "Error: " + e.message;
      $("vaultState").className = "hint err";
    }
  }
});

$("regrant").addEventListener("click", async () => {
  const handle = await getVaultHandle();
  if (!handle) {
    $("vaultState").textContent = "No folder set yet — choose one first.";
    $("vaultState").className = "hint err";
    return;
  }
  const ok = await requestPermissionNow(handle);
  if (ok) {
    $("vaultState").innerHTML = `Set: <code>${handle.name}</code> — access granted.`;
    $("vaultState").className = "hint ok";
  } else {
    $("vaultState").textContent = "Permission not granted.";
    $("vaultState").className = "hint err";
  }
});

$("save").addEventListener("click", async () => {
  const settings = {
    tags: $("tags").value.trim(),
    filenamePattern: $("pattern").value.trim() || "{date} {title}",
  };
  await chrome.storage.local.set({ settings });
  $("saveState").textContent = "Saved.";
  $("saveState").className = "hint ok";
  setTimeout(() => ($("saveState").textContent = ""), 1500);
});

load();
