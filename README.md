# Claude Chat Clipper

A tiny browser extension that copies the open **claude.ai** conversation as
Markdown or JSON, or downloads it as a `.md` file. Three buttons, no accounts,
no settings, nothing leaves your browser.

![MIT licensed](https://img.shields.io/badge/license-MIT-green.svg)
![Manifest V3](https://img.shields.io/badge/manifest-v3-blue.svg)

## Why

Claude's built-in export gives you a zip of everything, days later. Copying by
hand loses code fences and mangles lists. Scraping the page misses turns
because the chat is virtualised and streams. This extension asks claude.ai for
the same JSON the page itself loads, so every turn on the branch you are
looking at comes through, including the reply that just finished.

## What you get

| Button | Output |
|--------|--------|
| **Copy as Markdown** | Role-labelled transcript. Code fences, lists and tables intact. Artifacts rendered once at their final version. Thinking and tool noise left out. Paste into any editor or notes app. |
| **Copy as JSON** | The full archive: every turn with its raw content blocks (text, thinking, tool calls, tool results), timestamps, attachments, model and conversation id. |
| **Download .md** | The Markdown saved to `Downloads/YYYY-MM-DD Title.md`, dated by when the conversation started. |

Sample Markdown output:

````markdown
# Sorting a list in Python

- Source: https://claude.ai/chat/…
- Model: claude-opus-5
- Started: 2026-09-01T14:02:11Z
- Clipped: 2026-09-06T09:40:03Z

---

## 🧑 You

How do I sort a list of dicts by a key?

## 🤖 Claude

Use `sorted()` with a key function:

```python
rows = sorted(rows, key=lambda r: r["name"])
```
````

## Install

Works in Edge and Chrome. It is not on a store; load it unpacked.

1. Download or clone this repo.
2. Open `edge://extensions` (or `chrome://extensions`) and turn on
   **Developer mode**.
3. Click **Load unpacked** and select the repo folder.
4. Open a conversation on claude.ai, click the toolbar icon, pick a button.

The extension only asks for permission on `claude.ai`, plus clipboard and
downloads. It has no background process and makes no network requests other
than the one to claude.ai from inside your own tab.

## Privacy

Everything runs inside the claude.ai tab you already have open, using your
existing login. The extension has no server, no analytics, and no storage. What
you copy goes to your clipboard or your Downloads folder and nowhere else.

## How it works, briefly

claude.ai loads each conversation from an internal JSON endpoint. The extension
calls that same endpoint from inside the tab and walks the message tree from the
current leaf to the root, which yields exactly the branch on screen. Claude's
replies are already Markdown, so nothing is converted; artifacts are folded to
their last version and emitted as fenced code.

If the request fails (endpoint changed, logged out), a small DOM scraper takes
over and the status line says so. It is a stopgap: it cannot see artifact
contents and may miss turns.

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Caveats

- The endpoint is internal to claude.ai and unofficial. If Anthropic changes
  it, the fallback keeps you going and the fix lives in one file.
- Clipping while a reply is still streaming captures it as far as the server
  has it.
- Attachments are listed by filename; their contents are not fetched.

## Contributing

Bug reports and pull requests are welcome. There is no build step: edit a file,
reload the extension. Tests are one HTML page; see
[docs/TESTING.md](docs/TESTING.md) for running them and recording a fixture
from a real conversation.

## License

[MIT](LICENSE). Not affiliated with Anthropic.
