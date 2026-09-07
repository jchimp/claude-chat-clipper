// =============================================================================
// clip.js — page-side entry point. API first; DOM fallback only when the API
// path throws. Returns a plain serializable object for the popup.
// =============================================================================
(function () {
  const NS = (window.__claudeClipper = window.__claudeClipper || {});

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
    let apiError;
    try {
      const raw = await NS.fetchConversation();
      return finish(NS.toTranscript(raw, url), "");
    } catch (err) {
      apiError = err && err.message ? err.message : String(err);
    }
    try {
      const transcript = NS.domFallback(url);
      return finish(transcript, `DOM fallback (API failed: ${apiError}). Turns may be incomplete.`);
    } catch (err) {
      const domError = err && err.message ? err.message : String(err);
      return { ok: false, error: `API: ${apiError} | DOM fallback: ${domError}` };
    }
  };

  window.__clipClaude = NS.clip;
})();
