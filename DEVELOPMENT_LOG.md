# MemClip — Development Log

A record of the debugging and development session that took MemClip from a partially-broken prototype to a working browser extension, plus the roadmap agreed for future work.

- **Project:** MemClip — a clipboard-history browser extension (Manifest V3) that remembers what you copied, where you copied it from, and where you pasted it.
- **Environment:** Windows, Opera (Chromium-based), unpacked extension loaded via `opera://extensions`.
- **Files:** `manifest.json`, `background.js`, `content.js`, `popup.html`, `popup.css`, `popup.js`, plus `icons/`.

---

## 1. Initial analysis

A walkthrough of all six source files established what the extension is and how it's meant to work.

| File | Role |
|------|------|
| `manifest.json` | MV3 config: permissions, content script, service worker, keyboard command |
| `content.js` | Injected into every page; captures `copy`/`paste` events, writes to `chrome.storage.local` |
| `background.js` | Service worker; message router for the popup |
| `popup.html` / `popup.css` / `popup.js` | UI: list, search, tabs, stats, settings, detail, debug console |

**Intended data flow:** `content.js` listens for `copy`, stores a clip object (text + source URL/title/scroll position) in `chrome.storage.local` under `memclip_history`, de-duplicating and capping at 1000 entries. On `paste`, it finds the matching clip and records the destination. `popup.js` reads storage to render clips; `background.js` routes popup actions.

### Critical problems identified up front
1. **`background.js` was broken** — every message handler called functions (`getClips`, `getStats`, `deleteClip`, `clearAll`, `pinClip`, `openSource`, `purgeOldClips`, `addDebugLog`, `safeSend`) and a variable (`DEBUG_LOGS`) that were **never defined**. Only the listener half existed.
2. **The popup was unreachable** — `manifest.json` had no `action`/`default_popup`, and the `toggle-memclip` command had no listener.
3. Minor: `debugLog` called before definition (saved by hoisting), focus-stealing poll, lots of debug logging, but XSS handled correctly via `escapeHtml`.

---

## 2. Debugging the core copy/paste capture

The user reported copy/paste — the core function — was not working properly.

### Method
- Ran `node --check` on all scripts → **no syntax errors**, so the scripts load fine; the issue was logic.
- Built a throwaway Node harness that loaded `content.js` into a mock Chrome/DOM environment and replayed real `copy`/`paste` events to observe exactly what got stored. (Harness was deleted afterward.)

### Root causes found (and confirmed empirically)
1. **`extractTextFromClipboardEvent()` never returns text on copy.** During a `copy` event, `e.clipboardData.getData('text/plain')` is **spec-guaranteed empty** (the clipboard is in write-mode there). The harness confirmed it returned `''` every time. So the whole copy feature secretly depended on the `getSelectedText()` fallback.
2. **The selection fallback misses common cases:** copy buttons / `navigator.clipboard.writeText` (GitHub, code blocks, copy icons) fire no usable selection, and selections inside **Shadow DOM** / web components return empty → nothing captured.
3. **Paste tracking only worked for already-captured text.** The paste handler required an exact match in history; pasting anything copied elsewhere produced `no matching clip found` and was silently dropped.

| Scenario | Before |
|----------|--------|
| Select + Ctrl+C | works (via selection fallback only) |
| Copy button / no selection | dropped |
| Selection inside Shadow DOM | dropped |
| Paste of previously-captured text | recorded |
| Paste of externally-copied text | dropped |

---

## 3. Fixes to copy/paste capture

**`content.js`**
- Copy handler still tries event data + DOM selection first, then falls back to reading the **real system clipboard** via `navigator.clipboard.readText()` inside `setTimeout(…, 0)` (after the browser finishes writing). This fixes copy buttons and programmatic clipboard writes.
- Extracted the storage logic into a reusable `saveCopiedClip(text)`.
- `getSelectedText()` now walks into open **shadow roots** and reads `shadowRoot.getSelection()`.
- Paste handler now **creates a new clip** for text it can't match (flagged `externalOrigin: true`) instead of dropping it.

**`manifest.json`**
- Added `"clipboardRead"` permission.
- (Initially) added an `action` with `default_popup` to make the UI openable.

Re-ran the harness to confirm the previously-broken scenarios now capture correctly.

**Caveats noted:** `clipboard.readText()` only works when the document is focused and may prompt on first use; `background.js` was still non-functional at this point.

---

## 4. Reconstructing `background.js`

Implemented every missing function the listener referenced, verified against a mock Chrome:

- `safeSend` — wraps `sendResponse` in try/catch so a dismissed popup (closed channel) no longer throws (this was why every handler crashed).
- Shared helpers `readStorage` / `writeStorage` / `sortHistory` (pinned first, then newest — matching `popup.js`/`content.js`).
- `getClips`, `getStats`, `getDomains`, `deleteClip`, `clearAll`, `pinClip`, `openSource` (opens source tab + sends `SCROLL_TO`), `purgeOldClips` (honors `meta.retentionDays`, 0 = forever, keeps pinned).
- Debug console support: in-memory `DEBUG_LOGS` ring buffer (capped 500) + `addDebugLog`.
- Scheduled retention purge on install/startup (~once/day via `meta.lastPurge`).
- Wired the `toggle-memclip` keyboard shortcut.

Response shapes verified to match what the popup consumes (e.g. `GET_STATS` → `topDomains: [[name,count]]`).

---

## 5. Popup wouldn't open in Opera

**Reported:** clicking the extension didn't show the popup; it wasn't a resizable window; only the keyboard shortcut opened it; clips showed in **Stats** but not under **All** / **By Site**.

### Findings & fixes
- **Popup invisible / collapsed:** `popup.css` sized the popup with `width: 100%; height: 100%`. An extension popup has no intrinsic viewport, so `%` collapsed to ~zero — the window opened but was invisible.
- **Switched to a real window:** removed `default_popup`; added `chrome.action.onClicked` in `background.js` that opens `popup.html` via `chrome.windows.create({ type: 'popup', width: 420, height: 620 })`. This makes it a **resizable pop-out window that opens on click**, focuses the existing window on repeated clicks (tracked via `memclipWindowId` + `windows.onRemoved`), and the shortcut opens/focuses the same window. `popup.css` reverted to `100%` so the body fills (and resizes with) the window.
- **Stats showed clips but All/By Site were empty:** root cause was that `clearAll` wiped `memclip_history` but **left `memclip_stats` untouched**, so Stats rendered phantom counts while the (correct) history-backed tabs were empty. Fixed `clearAll` to **recompute stats from the surviving (pinned) clips**.
- **Note on stale content scripts:** after reloading an unpacked extension, content scripts already injected into open tabs are orphaned and can't save copies until those tabs are refreshed.

Confirmed via mock Chrome: first click creates the window, later clicks/shortcut focus it; after `CLEAR_ALL`, stats reflect only remaining clips.

The user confirmed: **"Everything is working as intended."**

---

## 6. Toolbar icon

- Generated an amber clipboard-and-clock icon on a dark rounded-square background, matching the app's accent color (`#f59e0b`) and theme (`#0d1117`).
- Cropped the landscape source to a centered square and exported standard sizes using Windows `System.Drawing` (no Python/ImageMagick available): `icons/icon16.png`, `icon32.png`, `icon48.png`, `icon128.png`.
- Wired into `manifest.json` as both top-level `icons` and `action.default_icon`.

---

## 7. Current status

- Copy/paste capture: **fixed** (system-clipboard fallback, shadow DOM, external-paste tracking).
- `background.js`: **fully implemented and verified.**
- Popup: **resizable pop-out window, opens on toolbar click and via `Ctrl+Shift+M`.**
- `clearAll`: **resets stats** (no more phantom counts).
- Toolbar icon: **added at all standard sizes.**

> Reminder: this is still a "DEBUG BUILD" with verbose `console.log`/`debugLog` output and broad permissions (`<all_urls>`, `clipboardRead`). Both should be addressed before public release (see roadmap Phase 1–2).

---

## 8. Roadmap — prototype → publishable extension

### Phase 1 — Correctness & resilience
- Serialize storage writes / move all writes into the background worker (avoid read-modify-write clobbering across tabs).
- Quota & large-clip handling; consider IndexedDB for scale.
- Decide on rich content (HTML/images) capture vs text-only.
- Graceful degradation when clipboard reads are blocked.
- Promote the debug harnesses into a real `test/` suite with a mock `chrome`.

### Phase 2 — Privacy & security (required before public release)
- Detect/skip/redact sensitive data (passwords, card numbers, `type="password"`); per-site denylist; incognito exclusion.
- Optional local encryption of stored clips.
- Clear-data controls + privacy policy.
- CSP review; **strip all debug logging** from the production build.

### Phase 3 — Core UX polish
- Quick-paste hotkeys (paste clip #1–9).
- Edit clips, multi-select, bulk delete, reorder pinned.
- Better search (fuzzy, filter by type/site/date); keyboard-first nav.
- Type-aware actions (open URL, mailto, code highlighting).
- Theme support (light/dark/system); persist popup size.
- First-run onboarding.

### Phase 4 — Cross-browser reliability
- Test Chrome, Edge, Brave, Opera; Firefox port (`browser.*`, MV3 differences).
- Harden service-worker lifecycle (no reliance on in-memory state surviving termination).
- i18n scaffolding (`_locales/`).

### Phase 5 — Optional sync & power features
- Cross-device sync (`chrome.storage.sync` for small clips, or opt-in account/backend).
- Export/import (JSON) + backup.
- Snippets/templates with shortcuts.

### Phase 6 — Packaging & store deployment
- Production build pipeline (strip debug, minify, version bump, zip).
- Store assets (listing copy, screenshots, promo tiles, privacy policy URL).
- Submit to Chrome Web Store, Edge Add-ons, Opera Addons, Firefox AMO (justify broad permissions in the listing).
- Versioning, update notes, support channel.

### Suggested immediate next steps
1. Phase 1: centralize writes in the background worker + storage queue (prevents data loss).
2. Phase 2: sensitive-data skip + remove debug logging (release blocker).
3. Phase 3: quick-paste hotkeys + edit/delete polish (most user-visible).

---

## 9. Phase 1 — Correctness & resilience (completed)

Goal: eliminate data-loss races and make storage robust, plus stand up automated tests.

### Single writer + serialized write queue (`background.js`)
- The background service worker is now the **only writer** to `chrome.storage`. `content.js` no longer writes directly.
- All mutations (`addClip`, `recordPaste`, `deleteClip`, `clearAll`, `pinClip`, `purgeOldClips`) run through a **serialized promise queue** (`enqueue`), so concurrent copies from multiple tabs, popup actions, and the scheduled purge execute strictly one-at-a-time and can't clobber each other's read-modify-write cycles.
- Added promise-based `getAsync`/`setAsync`; read-only queries (`getClips`/`getStats`/`getDomains`) stay un-queued (storage reads are atomic snapshots).

### Quota & large-clip handling (`background.js`)
- **Per-clip cap** `MAX_CLIP_BYTES` (256 KB): oversized clips are truncated via `capText` and flagged `truncated`.
- **Quota-aware writes**: `saveState` enforces `MAX_CLIPS` (1000), and on a failed write (e.g. `QUOTA_BYTES`) it **sheds the oldest unpinned clips and retries** (up to `QUOTA_RETRY_LIMIT`). Pinned clips are never shed.

### Message-based capture (`content.js`)
- Copy → `ADD_CLIP` message; paste → `RECORD_PASTE` message (clip construction/dedup/stats now live in the background).
- Hardened `sendBg` wrapper catches **"Extension context invalidated"** (orphaned content scripts after an extension reload) and `lastError`, so the page never breaks — it just needs a refresh to re-inject.
- Kept the capture logic that was fixed earlier (clipboard-read fallback, shadow-DOM selection, rapid-duplicate suppression). Copy/paste indicators now reflect the background's response (`Saved to MemClip` / `storage full`).

### Automated test suite (`test/`, `package.json`)
- `test/mock-chrome.js`: configurable mock with **asynchronous** storage (random delay) and a settable quota — so the queue and quota paths are genuinely exercised.
- `test/background.test.js` (run with `npm test` / `node --test`): 11 tests covering add/dedup, **50 concurrent copies with zero lost writes**, pin sorting, paste matching + external-origin creation, delete, clear-keeps-pinned + stats rebuild, `capText` truncation, quota shedding, and "pinned never shed". **All passing.**

### Deferred decisions
- **Rich content (images/HTML): deferred.** MemClip remains text-only for now; revisit in a later phase.

### Status after Phase 1
- No more cross-tab write races; storage is quota-safe; capture survives extension reloads (after a tab refresh); behavior is locked in by tests.
- Still a DEBUG build with verbose logging and broad permissions — addressed in Phase 2.

---

## 10. Post-Phase-1 bug fixes (from user testing)

User report: paste tracking and external paste "not working"; deleting a clip in All also removed it from Pinned.

- **Paste tracking not displaying (root cause):** the popup only re-rendered when the clip *count* changed (focus handler + 500ms poll). A paste updates an existing clip's `pasteCount`/`pastedTo` without changing the count, so the data was saved but never shown. Replaced the polling/focus-count logic with a `chrome.storage.onChanged` listener that refreshes on **any** `memclip_history` change (pastes, pins, deletes). Also removed the focus-stealing `window.focus()` call (bad for the pop-out window).
- **Detail view freshness:** `showDetail` now re-reads the clip from storage by `id` before rendering, so "Times used" / "Pasted To" are never stale.
- **Iframe capture:** added `"all_frames": true` to the content script. Previously it ran only in the top frame, so pastes/copies inside iframe-based editors (Google Docs, many comment boxes) were never captured.
- **Pinned-clip deletion:** by design a pinned clip and its "All" entry are the same object. Per user choice, deleting a pinned clip now shows a confirmation ("This clip is pinned — delete anyway?") instead of silently removing it everywhere.

---

## 11. Revert of Phase 1 capture architecture (reliability)

User report: after the Phase 1 message-passing rewrite, copies/pastes stopped showing under "All" (Stats still showed stale counts). Requested a revert + fresh patch.

**Decision:** the storage race that Phase 1 solved was not the user's real-world problem; the message-passing architecture (capture depends on the service worker being awake and the content script not being orphaned) was too fragile. Reverted capture to **direct `chrome.storage.local` writes from `content.js`** — the approach previously confirmed working.

- `content.js`: copy and paste now read-modify-write storage directly again, keeping all capture improvements (clipboard.readText fallback, shadow-DOM selection, external-paste creation, rapid-dup suppression). Added a `storageAvailable()` guard (handles orphaned content scripts after reload) and a `MAX_CLIP_CHARS` (200k) truncation guard.
- **Kept** the genuinely valuable fixes: popup live-updates via `chrome.storage.onChanged` (this is what makes paste tracking actually display — a paste mutates an existing clip, which `onChanged` catches even though the count is unchanged), detail-view freshness, pinned-delete confirmation, `all_frames` capture, and the background popup-action handlers.
- `background.js`: unchanged. Its `ADD_CLIP`/`RECORD_PASTE` handlers are now unused by the content script but remain valid and test-covered; popup actions (stats, delete, pin, clear, open-source, purge) still route through it.
- Tests still pass (12).

**Trade-off:** direct writes reintroduce the theoretical cross-tab write race Phase 1 removed. Acceptable for now given reliability; can be re-added later via a more robust mechanism (e.g. message-with-direct-write-fallback) if it ever manifests in practice.

---

## 12. End-to-end verification in a real browser

After repeated "still not working" reports, capture/render were verified two ways instead of by reasoning alone:

- **jsdom integration tests (`test/integration.test.js`):** load the *real* `content.js` (capture) and the *real* `popup.html` + `popup.js` (render) against one shared `chrome.storage` mock with a working `onChanged` dispatcher. Confirms: a stored clip renders under **All**; a live copy appears via `onChanged`; a paste shows "used 1x" live.
- **Real-Chromium test (`test/browser.mjs`, Playwright):** loads the actual unpacked extension into headed Chromium (the engine Opera is built on), serves a local HTTP page, performs a real `copy` (and a real Ctrl+V paste), then asserts the clip lands in `chrome.storage` (read from the MV3 service worker) **and** renders in the real `popup.html`. All green. This is the definitive proof the pipeline works; remaining user-side failures were stale-window / orphaned-content-script state after reloads.
- **Popup resilience:** `loadClips` now detects an invalidated extension context (orphaned pop-out window after a reload) and shows "MemClip was updated — close and reopen", and treats a non-array `memclip_history` as empty (corrupted-storage guard).

Run: `npm test` (unit + integration) and `npm run test:browser` (real Chromium).

---

## 13. Phase 1 — properly finished in the live write path

Phase 1's queue/quota work originally lived in `background.js`, but capture was reverted to direct `content.js` writes (§11), so those protections weren't actually in effect. Closed the gap **in the live path**:

- **Quota-safe writes (`content.js` `commitState`):** a single commit path for both copy and paste. On a `QUOTA_BYTES` failure it **sheds the oldest unpinned clips (~10%/try) and retries** up to 6 times; pinned clips are never shed. Verified by an integration test that forces a byte quota and asserts the new clip is saved, pinned survives, and the final state fits.
- **Pinned-aware cap:** `enforceClipLimit` keeps all pinned clips and fills the remainder up to `MAX_CLIPS` (fixes the old `slice(0, MAX_CLIPS)` that ignored the pinned count).
- **Bounded stats:** `pruneStatsMap` caps `topDomains` / `topPasteDestinations` at the 250 highest-count keys, so the stats object can't grow unbounded over time.

---

## 14. Phase 2 — Privacy & security

Goal: make MemClip safe to release publicly.

### Sensitive-data protection (`content.js`)
A settings cache (`memclip_settings`, hot-reloaded via `chrome.storage.onChanged`) gates every capture through `captureBlockReason(text, hostname)`:

- **Ignore sensitive data (default on):** high-confidence patterns only, to avoid eating legit copies — credit-card numbers (Luhn-validated), US SSNs, `BEGIN ... PRIVATE KEY` blocks, and known token prefixes (`AKIA…`, `ghp_/gho_/ghs_…`, `sk-…`, `xox[baprs]-…`, `AIza…`). Skipped copies show a brief "skipped sensitive data" indicator.
- **Skip password fields (default on):** copies/pastes whose active element is `<input type="password">` (pierces shadow roots) are ignored.
- **Incognito excluded (default):** `chrome.extension.inIncognitoContext` captures are dropped unless the user opts in.
- **Per-site denylist:** hostnames that never capture (suffix match, so `blocked.com` also covers `*.blocked.com`).

### Settings UI (`popup.html` / `popup.js` / `popup.css`)
New **Privacy & Security** section in Settings: three toggles + a blocked-sites textarea (auto-saved on change to `memclip_settings`). Added an **Erase Everything** control (`chrome.storage.local.clear()`) alongside the existing pinned-preserving "Clear All History".

### Production hardening
- **Debug logging gated:** `DEBUG = false` flags in `content.js` and `popup.js`. In production the content script is silent (no `console` spam, and it no longer wakes the service worker with `DEBUG_LOG` traffic); genuine errors still surface via `console.error`. Verified by the browser test ("content-script logs seen: 0").
- **CSP:** added an explicit `content_security_policy.extension_pages` (`script-src 'self'; object-src 'self'; base-uri 'self'`). `popup.html` already has no inline scripts.
- **Privacy policy:** added `PRIVACY.md` (local-only, no network/telemetry, permission justifications, user controls).

### Tests
Added Phase 2 integration tests (sensitive-data skip, password-field skip, denylist incl. subdomain, positive control) and a real-Chromium assertion that a Luhn-valid card is **not** stored. Suite now **19 unit/integration tests + browser test, all passing**.

### Deferred
- **Optional local encryption: deferred.** With the key necessarily stored locally next to the data, at-rest encryption adds little real protection against local attackers while adding complexity; revisit if a passphrase-locked mode is wanted.

### Status after Phase 2
Sensitive data is skipped by default, users have per-site and incognito controls, all data is erasable, the production build is quiet, and CSP/privacy-policy are in place — the major release blockers from the roadmap are cleared.

---

## 15. Post-Phase-2 fix — "copy stopped showing up"

User report: after Phase 2, copies stopped appearing; everything else worked.

**Root cause:** the new privacy gate (`captureBlockReason`) dropped copies **silently** — a denylisted site, the sensitive-data filter, or incognito would skip the copy with no feedback, which is indistinguishable from "copy is broken." Real-Chromium repro confirmed: a normal copy is captured with default settings, is blocked only when the host is on the denylist (or the text is sensitive), and recovers when the denylist is cleared.

**Fixes (`content.js`):**
- Every skip now shows a visible reason toast (`MemClip: site is blocked` / `skipped sensitive data` / `skipped password field` / `off in incognito`) instead of failing silently.
- `captureBlockReason` is wrapped in try/catch and **fails open** — a privacy-check error can never break the core capture.

**Tests:** added real-Chromium checks that (a) a normal copy is still captured with default settings present, (b) a denylisted host blocks capture, and (c) clearing the denylist restores capture. Suite: 19 unit/integration + 7 browser checks, all green.

**User remedy:** Settings → Privacy & Security → clear "Blocked sites" / adjust toggles; also refresh any tab opened before the extension was reloaded (orphaned content scripts can't capture until refreshed).

---

## 16. Phase 3 — Core UX polish

User direction: redesign the UI as a **"Matrix / retro-modern"** theme and add a set of power-user features. Design brief gathered via Q&A:

- Theme: softer terminal green `#33ff77` on near-pure black `#0a0a0a`, subtle phosphor glow on accents/active only, monochrome all-green (no second accent), classic red `#f85149` for danger, system UI font, balanced contrast, comfortable density, subtle animations, terminal-style typing reveal on text.
- Features chosen: better search (fuzzy + filters), type-aware actions, persist popup size, reorder pinned (drag), multi-select + bulk delete.

### Theme (`popup.css` — full rewrite)
- New green-on-black token system (`--accent`, `--accent-soft/dim/faint`, green-tinted backgrounds/borders, green type accents) plus `--glow*` shadows.
- Subtle phosphor glow via `text-shadow`/`box-shadow` on the logo, active tab, active filter chips, selected-row marker, focused inputs, toast, and stat values. Monospace retained for clip text/detail/debug (terminal feel); system font for chrome.
- Animations: list slide-in + a cheap staggered fade-up for the first screenful; **`@media (prefers-reduced-motion: reduce)`** disables all of it.

### Terminal typing-reveal (`popup.js`)
- `typeReveal(el, text, speed)` types text out char-by-char with a blinking block caret (`.term-caret`), used for panel titles (on view enter) and the empty-state heading. Instant when reduced-motion is set. Timers tracked and cleared on re-render so they can't leak.

### Better search (`popup.js`)
- `scoreClip` ranks by direct substring hits (text/host/title, with start-of-string and field boosts) and falls back to `fuzzyScore`, a subsequence matcher that rewards contiguous runs and early matches. Results are score-sorted while searching.
- **Filter bar:** type chips (All/Text/Link/Email/Code) + a date `<select>` (Any/Today/7d/30d). Filters compose with search and are persisted in `memclip_ui_state` (pinned clips bypass the date filter).

### Type-aware actions (`popup.js`)
- Detail view builds quick actions by clip type: **Copy** always; **Open link** (`chrome.tabs.create`) for URLs; **Compose email** (`mailto:`) for emails.
- `highlightCode` — a dependency-free **single-pass tokenizer** (comments/strings/keywords/numbers) for `code` clips. (First attempt used sequential regex `.replace()` and corrupted its own injected markup by re-matching attribute quotes — caught in a screenshot, rewritten as a one-pass scanner with a length guard and fast text-escape.)

### Multi-select + bulk ops (`popup.html`, `popup.js`, `background.js`)
- Header toggle enters select mode: per-row checkboxes, a selection toolbar (count + **Pin** / **Delete** / **Cancel**). Selection survives live re-renders (kept in a `selectedIds` map).
- New background `deleteClips(ids)` (single queued, quota-safe write) + `DELETE_CLIPS` message; bulk pin reuses `PIN_CLIP`.

### Reorder pinned (drag) (`popup.html`, `popup.js`, `background.js`)
- On the Pinned tab, rows get a drag handle and HTML5 drag-and-drop. Dropping computes the new pinned id order and sends `REORDER_PINNED`.
- Background `reorderPinned(order)` stamps an ascending `pinRank`; `sortHistory` now orders pinned clips by `pinRank` (falling back to newest-first). `pinClip` clears `pinRank` on unpin. Popup mirrors the same sort (`sortClips`) so display and live updates match.

### Persist popup size/position (`background.js`)
- Window create restores `memclip_window_bounds` (clamped) and applies last left/top. Bounds are saved on `windows.onBoundsChanged`, with an `onFocusChanged` fallback for browsers that don't fire it reliably.

### Tests & verification
- Unit/integration: **22 passing**, incl. new `deleteClips` and `reorderPinned`/`pinRank` ordering tests.
- Real Chromium (`test/browser.mjs`): **14 checks passing**, now including theme accent = `#33ff77`, type-filter (Link) shows only URLs, fuzzy search (`plnwrds` → "plain words"), type-aware "Open link" in detail, multi-select bulk delete to zero, and **no uncaught popup JS errors**.
- Visual pass via `test/screenshot.mjs` (main list, code-detail with highlighting, settings) confirmed the aesthetic and caught the highlighter bug above.

### Status after Phase 3
MemClip now has a cohesive retro-terminal look with fuzzy/filtered search, type-aware actions, multi-select bulk operations, drag-reorderable pins, and a window that remembers its size — all covered by automated + real-browser tests.

---

## Phase 4 — Cross-browser reliability

Goal: make the same source load and behave correctly on Chromium browsers (Chrome/Edge/Brave/Opera) **and** Firefox, and stop relying on background state that doesn't survive a service-worker teardown.

### Cross-browser manifest (`manifest.json`)
- **Dual background key** (the documented MDN pattern): `service_worker` *and* `scripts: ["background.js"]`. Chromium uses the service worker and ignores `scripts`; Firefox (which has no MV3 service worker) uses `scripts` as an event page. `background.js` was already a classic, side-effect-light script (the `module.exports` block is guarded by `typeof module`), so it runs cleanly in both contexts.
- **`browser_specific_settings.gecko`** added: `id` (required for Firefox signing/distribution), `strict_min_version: "142.0"`, and `data_collection_permissions: { required: ["none"] }` — MemClip stores everything locally and transmits nothing, so "none" is accurate (and the key is now mandatory for new Firefox submissions; it needs FF 140 desktop / 142 Android, hence the floor).

### i18n scaffolding (`_locales/en/messages.json`, `manifest.json`, `popup.*`)
- Added `default_locale: "en"` and a full `_locales/en/messages.json`. Manifest `name`/`description`/command description now use `__MSG_*__`.
- `popup.html` static strings carry `data-i18n` / `data-i18n-placeholder` attributes (tabs, filters, select bar, panel titles, settings labels/hints, footer). Labels with nested `<small>`/`<kbd>` were restructured so i18n only ever targets leaf text nodes.
- `popup.js` `localizeDom()` runs on init via `chrome.i18n.getMessage`, **failing open** to the existing English markup if a message is missing, so the UI can never go blank. `chrome.i18n` works identically across Chromium and Firefox.

### Service-worker lifecycle hardening (`background.js`)
- The pop-out window id was tracked only in memory; if the worker was torn down while the window was open, reopening would spawn a **duplicate**. `openMemclipWindow` now calls `recoverExistingWindow()` (a `chrome.tabs.query` for `popup.html`) to re-adopt and focus the existing window before ever creating a new one. The focus-failure path now retries through the same recovery instead of blindly creating.

### Namespace compatibility
- Kept the callback-style `chrome.*` API throughout: it's natively available in all target Chromium browsers and aliased in Firefox, so no `browser`/polyfill rewrite was needed. Firefox-unsupported calls (`windows.onBoundsChanged`) were already feature-guarded with an `onFocusChanged` fallback.

### Tests & verification
- New `test/manifest.test.js`: asserts MV3 + identity keys, the dual background keys, `gecko.id` + `data_collection_permissions`, and that **every `__MSG__` and `data-i18n` key actually resolves** in the locale file. Wired into `npm test`.
- Unit/integration: **28 passing** (was 22).
- Real Chromium (`test/browser.mjs`): **16 checks passing**, adding `chrome.i18n.getMessage(extName) === "MemClip"` and localized tab/placeholder verification.
- **Firefox validation via Mozilla `web-ext lint`: 0 errors, 0 notices.** Remaining 9 warnings are inherent/benign: `BACKGROUND_SERVICE_WORKER_IGNORED` (the cross-browser pattern working as intended), `UNSUPPORTED_API` for the guarded `windows.onBoundsChanged`, and `UNSAFE_VAR_ASSIGNMENT` on our `escapeHtml`-sanitized `innerHTML`.

### Status after Phase 4
One source tree now targets Chromium and Firefox: dual background entry, Firefox gecko/data-collection metadata, i18n scaffolding ready for additional locales, and a pop-out window that recovers itself after a worker restart. Verified by 28 unit/integration tests, 16 real-Chromium checks, and a clean `web-ext lint` (0 errors).

---

## Phase 5 (slice) — Export / Import backup

Decision: rather than build all of Phase 5 before launch, ship **only export/import** with v1 (it's a near-essential trust feature for a clipboard tool and strengthens the data-portability story for store review). Snippets, `storage.sync`, and the paid tier are deferred until there are real users to inform what's worth building.

### Backend import path (`background.js`)
- `importData(payload, mode)` — a single queued, quota-safe write:
  - **merge** (default): folds clips into the current history, deduping by clip text (the same identity key used everywhere else); OR-s the `pinned` flag and keeps the higher `copyCount`/`pasteCount` and newer `timestamp`.
  - **replace**: swaps history wholesale and (only in this mode) restores saved settings, so a cross-device *merge* can never silently clobber local privacy choices.
  - Accepts several shapes (`{clips}`, `{history}`, bare array) and untrusted records: `sanitizeImportedClip` coerces every field and drops empties/junk; ids are de-collided after the fact. Stats are always **rebuilt from the resulting clips** (`rebuildStats`) — the file's stats are never trusted.
- New `IMPORT_DATA` message + exports for the test harness.

### Popup UI (`popup.html`, `popup.js`, `popup.css`)
- New **Backup** section in Settings: *Export to file* (downloads `memclip-backup-YYYY-MM-DD.json` via a Blob URL, including clips, stats, settings, meta) and *Import from file* (hidden file input → `FileReader` → `JSON.parse` with a friendly error → confirm dialog choosing **Merge** vs **Replace** → `IMPORT_DATA`).
- Added a themed `.btn-secondary` (accent-green) to distinguish backup actions from the red destructive ones. New strings added to `_locales/en`.

### Tests & verification
- Unit: **33 passing** (+5) covering merge-dedupe, pinned OR-ing, replace+settings-restore, malformed-record dropping/unique-ids, and bare-array import.
- Real Chromium (`test/browser.mjs`): **18 checks** (+2) — a full **export→wipe→import round-trip** (validates the downloaded JSON and that the clips come back).

### Status after Phase 5 (slice)
Users can now back up and restore (or move between devices manually) their entire history + settings as a JSON file — fully local, no account. Remaining Phase 5 items (sync, snippets, paid tier) intentionally deferred until post-launch feedback.

---

## Launch prep (Phase 6 — packaging & store deployment)

Strategy agreed with the owner: launch **free** on all stores first (build reviews + a user base), introduce the paid tier later via a no-backend service (ExtensionPay/license keys). No servers, no accounts — total cash cost is the **$5 one-time Chrome fee**. The "100% local, no account" story is also the marketing hook.

### Artifacts produced
- **`STORE_LISTING.md`** — name, summary, detailed description, categories/tags, single-purpose statement, and per-permission justifications for the review forms (with `{{placeholders}}` for email/URLs/developer).
- **`docs/`** — a ready-to-publish GitHub Pages site: `index.html` (themed landing page with hero, features, privacy section, store buttons) + `privacy.html` (hosted privacy policy) + `screenshot.png`. Doubles as the required privacy-policy URL host.
- **`store-assets/`** — three **1280×800** store screenshots (`01-history`, `02-detail`, `03-privacy`) generated by `test/store-screenshots.mjs`, which captures the real popup and composites it onto a branded canvas with captions (no image-lib dependency; popup inlined as a data URL).
- **`scripts/build.mjs`** (`npm run build`) — produces `dist/memclip-v<version>.zip` containing **only** runtime files (manifest, background, content, popup.*, icons/, _locales/). Builds the zip via .NET on Windows so entries use **forward slashes** with `manifest.json` at the root (PowerShell's `Compress-Archive` writes backslash paths that some stores/Firefox reject).
- **`SUBMISSION_CHECKLIST.md`** — end-to-end steps for Pages hosting, building, and submitting to Chrome/Edge/Firefox/Opera, plus the update flow.

### Verification
- `npm run build` → clean ~57 KB zip; confirmed entries use forward slashes and manifest sits at root.
- `npx web-ext lint --source-dir dist/memclip` → **0 errors, 0 notices** on the packaged build.
- Screenshots visually reviewed (history, detail, privacy/backup).

### Remaining (owner action — needs personal info / accounts)
- Fill `{{placeholders}}` (support email, developer name, Pages URLs).
- Enable GitHub Pages on `/docs`; register store accounts; upload the zip; submit.
- Post-approval: drop live store URLs into `docs/index.html`; gather reviews; launch posts.
