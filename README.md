# Claude Chat Clipper (Edge/Chrome, MV3)

Copy the open **claude.ai** conversation as Markdown or JSON, or download it as a
`.md` file. No scrolling, no vault, no settings. Three buttons.

## What it does

- **Copy as Markdown** — role-labelled transcript (`## 🧑 You` / `## 🤖 Claude`).
  Claude's replies are already Markdown, so code fences, lists and tables come
  through intact. Artifacts are rendered once, at their final version, as a
  fenced code block. Thinking blocks and tool results are left out.
- **Copy as JSON** — the full archive: every turn on the active branch with its
  raw content blocks (text, thinking, tool_use, tool_result), timestamps,
  attachments, model, and conversation id.
- **Download .md** — the Markdown, saved to `Downloads/YYYY-MM-DD Title.md`
  (dated by when the conversation started).

## How it works

claude.ai loads each conversation from its own JSON endpoint. The extension
calls the same endpoint from inside the tab, so the request is same-origin and
uses your existing login:

```
GET /api/organizations/{orgId}/chat_conversations/{convId}?tree=True&rendering_mode=messages&render_all_tools=true
```

`orgId` comes from the `lastActiveOrg` cookie, `convId` from the page URL. The
response contains every branch; the clipper walks from
`current_leaf_message_uuid` up the `parent_message_uuid` chain to export the
branch you are looking at. This is why the latest reply is never missing: there
is no DOM to be out of sync with.

If that request fails (endpoint renamed, not logged in), a small DOM scraper
takes over and the status line says so. The DOM path cannot recover artifact
contents and may be incomplete; treat it as a stopgap.

## Install (unpacked)

1. `edge://extensions` (or `chrome://extensions`) → enable **Developer mode**.
2. **Load unpacked** → select this folder.
3. Open a conversation on claude.ai → click the toolbar icon → pick a button.

## Files

| File | Context | Role |
|------|---------|------|
| `manifest.json` | — | MV3 manifest, claude.ai host permissions |
| `popup.html` / `popup.js` | popup | Buttons, clipboard, download |
| `api.js` | page | Org id, conversation id, fetch JSON |
| `transcript.js` | page | Raw JSON → normalized transcript → Markdown, filename |
| `dom-fallback.js` | page | Structural scrape when the API fails |
| `html2md.js` | page | HTML → Markdown (fallback only) |
| `clip.js` | page | Entry point: API first, then fallback |
| `test/transcript.html` | — | Offline tests for `transcript.js` |

Page files are injected on demand with `chrome.scripting.executeScript`; each
is an IIFE writing into `window.__claudeClipper`, so nothing leaks or collides.

## Tests

Open `test/transcript.html` over `file://`. Section A always runs. Section B
runs against a recorded API response if present.

### Recording a fixture

On a claude.ai conversation, F12 → Console, paste:

```js
copy("window.FIXTURE_RAW = " + JSON.stringify(await (await fetch(
  `/api/organizations/${document.cookie.match(/lastActiveOrg=([^;]+)/)[1]}` +
  `/chat_conversations/${location.pathname.split("/chat/")[1]}` +
  `?tree=True&rendering_mode=messages&render_all_tools=true`)).json(), null, 2) + ";")
```

Paste the clipboard into `test/fixtures/conversation.js`. Redact anything you do
not want in the repo; the file is gitignored by default.

## Caveats

- The endpoint is internal to claude.ai and unofficial. If it changes, the
  fallback keeps you running and the status line tells you to look at `api.js`.
- Clipping mid-stream captures the reply as far as the server has it.
- Attachments are listed by filename only; their contents are not fetched.
