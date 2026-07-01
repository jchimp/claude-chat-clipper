// =============================================================================
// vault.js — writes the .md into your Obsidian vault folder.
// Primary path: File System Access API directory handle (granted once in the
// options page, persisted in IndexedDB) -> writes straight into the vault.
// Fallback: chrome.downloads (lands in your Downloads folder).
// =============================================================================

const VAULT_DB = "obsidian-clipper";
const VAULT_STORE = "handles";
const VAULT_KEY = "vaultDir";

function idb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(VAULT_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(VAULT_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, val) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VAULT_STORE, "readwrite");
    tx.objectStore(VAULT_STORE).put(val, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGet(key) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(VAULT_STORE, "readonly");
    const req = tx.objectStore(VAULT_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveVaultHandle(handle) {
  await idbSet(VAULT_KEY, handle);
}

async function getVaultHandle() {
  return idbGet(VAULT_KEY);
}

// Query only — safe to call any time, never needs a user gesture.
async function hasPermission(handle) {
  if (!handle) return false;
  return (await handle.queryPermission({ mode: "readwrite" })) === "granted";
}

// Prompts the user — MUST be called immediately after a click (fresh user
// activation), never after a long async step like the auto-scroll.
async function requestPermissionNow(handle) {
  if (!handle) return false;
  try {
    return (await handle.requestPermission({ mode: "readwrite" })) === "granted";
  } catch (e) {
    return false; // activation expired / popup lost focus — caller falls back
  }
}

// Write the note. Only QUERIES permission (no prompt here), so it can run after
// the scroll without tripping the user-activation rule. If we don't currently
// have write permission, it downloads instead of throwing.
async function writeNote(filename, contents) {
  const handle = await getVaultHandle();
  if (handle && (await hasPermission(handle))) {
    const fileHandle = await handle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(contents);
    await writable.close();
    return { method: "vault", path: filename };
  }
  // Fallback: download.
  const blob = new Blob([contents], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  await chrome.downloads.download({
    url,
    filename: "AI-Chats/" + filename,
    saveAs: false
  });
  return { method: "download", path: "Downloads/AI-Chats/" + filename };
}
