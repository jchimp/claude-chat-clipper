# Claude Chat Clipper — Install

Copies the open **claude.ai** conversation as Markdown or JSON, or downloads it
as a `.md` file.

This extension is not on the Edge Add-ons or Chrome Web Store. You install it by
pointing the browser at a folder on your disk, which takes about a minute.

---

## 1. Unzip it somewhere permanent

Unzip this archive to a folder you will not delete or move — for example:

```
C:\Users\<you>\Documents\ClaudeChatClipper
```

**Do not run it from your Downloads folder.** The browser does not copy these
files anywhere; it loads them from this folder every time it starts. If the
folder is moved, renamed or cleaned up, the extension stops working.

When you are done, the folder should contain `manifest.json` at the top level,
next to an `icons` folder. If you see a single folder inside the folder you
chose, go one level deeper — that inner folder is the one you want.

## 2. Open the extensions page

In Edge, type this in the address bar and press Enter:

```
edge://extensions
```

(In Chrome, use `chrome://extensions` — every other step is identical.)

## 3. Turn on Developer mode

Find the **Developer mode** toggle in the lower left of that page and switch it
on. This is what allows an extension to be loaded from a folder.

## 4. Load the folder

Click **Load unpacked**, then select the folder from step 1 — the one containing
`manifest.json`. Select the folder itself; do not open it and pick a file.

Claude Chat Clipper now appears in your extensions list.

## 5. Pin it to the toolbar

Click the puzzle-piece icon to the right of the address bar, find **Claude Chat
Clipper**, and click the eye or pin icon next to it. Without this the extension
works but stays hidden behind the puzzle menu.

## 6. Use it

1. Go to [claude.ai](https://claude.ai) and open a conversation.
2. Click the Claude Chat Clipper icon in the toolbar.
3. Choose **Copy as Markdown**, **Copy as JSON**, or **Download .md**.

| Button | What you get |
|---|---|
| **Copy as Markdown** | A readable transcript on your clipboard. Code blocks, lists and tables stay intact. |
| **Copy as JSON** | The full conversation data, including timestamps and attachments. |
| **Download .md** | The Markdown saved to `Downloads/YYYY-MM-DD Title.md`. |

---

## Verifying the download (optional)

The release includes a `.sha256` file. To confirm the zip arrived intact, run
this in PowerShell in the folder where you downloaded it:

```powershell
Get-FileHash .\claude-chat-clipper-*.zip -Algorithm SHA256
```

Compare the printed hash with the contents of the `.sha256` file. They should
match, ignoring letter case.

## Updating to a newer version

1. Download the new zip.
2. Delete the **contents** of your install folder and unzip the new files into
   that same folder, keeping the path the same.
3. Go to `edge://extensions` and click **Reload** on Claude Chat Clipper.

Keeping the same folder means you do not have to load it unpacked again.

## Removing it

Go to `edge://extensions` and click **Remove** on Claude Chat Clipper. Then
delete the folder if you want the files gone too.

---

## If something goes wrong

**"Manifest file is missing or unreadable"**
You selected the wrong folder. Pick the folder that has `manifest.json` directly
inside it, not its parent and not a subfolder.

**The extension disappeared after a restart**
The install folder was moved, renamed or deleted. Put it back, or unzip again
and load it unpacked once more.

**Edge keeps asking about developer-mode extensions**
Expected for extensions installed this way. Edge periodically checks that you
meant to install it. Choosing to keep it is safe.

**The buttons do nothing, or the icon is greyed out**
The extension only acts on `claude.ai` conversation pages. Make sure you are on
an open conversation, not the home or settings page. If you just installed or
reloaded the extension, refresh the claude.ai tab first — tabs opened before
that do not yet have the extension loaded.

**"Could not reach claude.ai"**
You are signed out, or the page had not finished loading. Sign in, let the
conversation render, and try again.

---

## What it can access

The extension asks for access to `claude.ai` only, plus permission to write to
your clipboard and save downloads. It runs entirely inside the claude.ai tab you
already have open, using your existing login. There is no server, no analytics
and no storage — what you copy goes to your clipboard or your Downloads folder
and nowhere else.

Licensed under MIT; see `LICENSE`. Not affiliated with Anthropic.
