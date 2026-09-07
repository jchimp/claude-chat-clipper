# Project Progress

## Current Focus
Claude-only, API-first clipper is written and passes offline tests. Needs a live check against a logged-in claude.ai tab to confirm the endpoint field names.

## Open Todos
- [x] Drop Copilot/M365 adapters and Obsidian vault code
- [x] Replace DOM scroll-and-harvest with same-origin API fetch
- [x] Popup: Copy Markdown / Copy JSON / Download .md
- [x] Offline test page for transcript.js
- [x] Load unpacked in Edge and verify last assistant turn present via Copy JSON
- [ ] Record a real API response into test/fixtures/conversation.js and run section B
- [ ] Verify artifact folding and branch selection on real conversations

## Progress Log

### 2026-09-06
- Pivoted to Claude-only after Copilot/M365 blocked extensions; renamed to Claude Chat Clipper.
- Replaced DOM scraping with a fetch of claude.ai's conversation JSON endpoint; DOM scraper kept only as fallback with the single-message root bug and empty code fence bug fixed.
- Decided: JSON export keeps thinking and tool blocks; Markdown is visible text plus artifacts folded to final version.
- Removed vault, options page, frontmatter scaffold, and all Copilot code (about 1700 lines down to about 650).
- 17 offline assertions pass in headless Edge; real-fixture section skipped until a response is recorded.
- Next: live verification on a logged-in tab, then commit.
- Made public-ready: friendly README, MIT LICENSE, tests and fixture notes moved to docs/TESTING.md.
