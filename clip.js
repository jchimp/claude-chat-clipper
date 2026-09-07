// =============================================================================
// clip.js — page-side entry point. Picks the provider for the current host,
// then API first; DOM fallback only when the API path throws. Returns a plain
// serializable object for the popup.
// =============================================================================
(function () {
  const NS = (window.__claudeClipper = window.__claudeClipper || {});

  // Host lists must match isSupportedUrl() in popup.js and manifest.json.
  const PROVIDERS = [
    {
      match: (h) => h === "claude.ai" || h.endsWith(".claude.ai"),
      fetch: NS.fetchConversation,
      toTranscript: NS.toTranscript,
      domFallback: NS.domFallback,
    },
    {
      match: (h) => h === "chatgpt.com" || h.endsWith(".chatgpt.com") || h === "chat.openai.com",
      fetch: NS.chatgpt.fetchConversation,
      toTranscript: NS.chatgpt.toTranscript,
      domFallback: NS.chatgpt.domFallback,
    },
  ];

  function finish(transcript, warning) {
    if (warning) transcript.warning = warning;
    return {
      ok: true,
      transcript,
      markdown: NS.toMarkdown(transcript),
      filename: NS.buildFilename(transcript),
      warning: warning || "",
    };
  }

  NS.clip = async function clip() {
    const url = location.href;
    const provider = PROVIDERS.find((p) => p.match(location.hostname));
    if (!provider) return { ok: false, error: `Unsupported site: ${location.hostname}` };
    let apiError;
    try {
      const raw = await provider.fetch();
      return finish(provider.toTranscript(raw, url), "");
    } catch (err) {
      apiError = err && err.message ? err.message : String(err);
    }
    try {
      const transcript = provider.domFallback(url);
      return finish(transcript, `DOM fallback (API failed: ${apiError}). Turns may be incomplete.`);
    } catch (err) {
      const domError = err && err.message ? err.message : String(err);
      return { ok: false, error: `API: ${apiError} | DOM fallback: ${domError}` };
    }
  };

  window.__clipClaude = NS.clip;
})();
