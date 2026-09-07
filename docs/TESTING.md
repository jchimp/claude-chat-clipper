# Testing

There is no build step and no test runner. Tests live in one HTML page.

## Running the tests

Open `test/transcript.html` in a browser over `file://`. The page title starts
with `PASS` or `FAIL`, so it also works headless:

```sh
msedge --headless=new --disable-gpu --allow-file-access-from-files \
  --dump-dom "file:///path/to/test/transcript.html" | grep -oE '<div id="summary">[^<]*'
```

**Section A** always runs. It checks the pure logic in `transcript.js` with
minimal structural inputs:

- active-branch walk from `current_leaf_message_uuid`
- index-order fallback when there is no leaf pointer
- thinking excluded from Markdown but retained in JSON
- artifact ops folded to a single final code block
- non-artifact tool use noted, tool results skipped
- fences grow past embedded backtick runs
- filename dating and character stripping

**Section B** runs only if `test/fixtures/conversation.js` exists. It checks a
real API response for the expected field names and renders the first part of
the Markdown on the page so you can eyeball it.

## Recording a fixture

On a claude.ai conversation, open DevTools (F12) → Console and paste:

```js
copy("window.FIXTURE_RAW = " + JSON.stringify(await (await fetch(
  `/api/organizations/${document.cookie.match(/lastActiveOrg=([^;]+)/)[1]}` +
  `/chat_conversations/${location.pathname.split("/chat/")[1]}` +
  `?tree=True&rendering_mode=messages&render_all_tools=true`)).json(), null, 2) + ";")
```

Paste the clipboard into `test/fixtures/conversation.js`. The file is
gitignored, so nothing from your conversations ends up in the repo. Redact it
anyway if you plan to share it.

## Manual checks after a change

1. Reload the unpacked extension.
2. On a long conversation, **Copy as JSON** and confirm the last assistant turn
   is present and the turn count matches the page.
3. **Copy as Markdown** and confirm code fences survive and no thinking text
   leaked.
4. On a conversation with an edited artifact, confirm one fenced block with the
   final content.
5. On a conversation where you edited a message, confirm the exported branch is
   the one on screen.
6. **Download .md** and check the file lands in Downloads.
7. If the status line ever says "DOM fallback", the API path failed. The
   message includes the HTTP status or error; start in `api.js`.
