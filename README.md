# Obsidian Chat Clipper (Edge, MV3)

Capture a **Claude.ai** or **Microsoft Copilot** conversation as clean Markdown,
pre-scaffolded with a notes block + highlights section, and drop it straight into
your Obsidian vault.

## What it does

- One click → reads the open conversation, converts it to Markdown.
- Writes a `.md` into your chosen vault folder (or downloads it if no folder is set).
- Every note starts with YAML frontmatter, a `> [!note] My notes` callout, a
  `## ⭐ Highlights` section, then the `## Transcript`. Annotate, done.
- "Copy as Markdown" if you'd rather paste it yourself.

## Install in Edge (unpacked)

1. `edge://extensions` → turn on **Developer mode** (left sidebar).
2. **Load unpacked** → select this folder.
3. The options page opens. Click **Choose vault folder…** and pick the folder
   *inside* your vault where clips should live (e.g. `YourVault/AI-Chats`).
   Set default tags / filename pattern if you like. Save.
4. Open a chat on claude.ai or copilot.microsoft.com → click the toolbar icon →
   **Clip to Obsidian**.

> The vault folder uses the File System Access API. You grant it once; the
> handle is remembered. On the first clip after a browser restart it may ask you
> to confirm write access again (one click). If you never set a folder, clips
> download to `Downloads/AI-Chats/`.

## The only thing you may need to tune: selectors

I built this without access to the live pages, so the per-site **root selector**
is a best guess. If a clip comes back empty or messy:

1. Open the conversation, press **F12 → Console**.
2. Click the extension once (this injects the helpers), then run:
   ```js
   __clipDiag()
   ```
   It prints which selectors currently match and how many turns it found.
3. If `root` shows ❌: right-click the message area → **Inspect**, find the
   smallest element that wraps the whole conversation, and add its selector to
   the **front** of `ROOT_SELECTORS` for that site in `adapters.js`.
4. For nice `## You / ## Assistant` splitting, do the same for `TURN_SELECTORS`
   (one selector that matches user turns, one for assistant turns). If turn
   detection finds nothing, it falls back to dumping the whole conversation as
   one block — still useful, just unlabelled.
5. Reload the page.

Everything tunable lives in **`adapters.js`** and nowhere else.

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 manifest, permissions, host matches |
| `adapters.js` | **Per-site selectors — the one file to tune** |
| `clipper-extract.js` | Runs in the page; pulls the conversation |
| `html2md.js` | HTML → Markdown converter |
| `normalize.js` | Claude-only Markdown tidy-up (strips UI chrome, blank lines) |
| `note.js` | Frontmatter + notes/highlights scaffold + filename |
| `vault.js` | Writes to the vault folder (FS Access API) or downloads |
| `popup.js` / `popup.html` | Toolbar UI |
| `options.js` / `options.html` | Vault folder + settings |
| `background.js` | Opens options on install |

## Honest caveats

- Claude and Copilot are **unofficial** targets. Their markup changes; when it
  does, you tune one selector (above), not the whole extension.
- Consumer `copilot.microsoft.com` and enterprise **M365 Copilot business chat**
  (`m365.cloud.microsoft`) are different surfaces. The consumer one is the easy
  case; the business one may be locked down by your tenant.
- The bundled HTML→MD converter is "good for notes," not pixel-perfect. If you
  want exact fidelity (edge-case tables, nested formatting), drop in
  [Turndown](https://github.com/mixmark-io/turndown) and call it from
  `html2md.js`.

## If you outgrow v1

Swap the `writeNote()` download/FS-Access path for a POST to a tiny local
FastAPI `/ingest` endpoint. That shim can own templating, dedupe, git commits,
and fan-out (Obsidian + Telegram), and unify any future surfaces behind one pipe.
