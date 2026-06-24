# MemClip — Privacy Policy

_Last updated: 2026-06-23_

MemClip is a browser extension that keeps a local history of text you copy and
paste, including where you copied it from and where you pasted it.

## What MemClip stores

MemClip stores the following **only on your own device**, using the browser's
local extension storage (`chrome.storage.local`):

- The text content of clips you copy or paste.
- Metadata for each clip: source page URL, page title, hostname, the page
  scroll position at copy time, timestamps, copy/paste counts, and the list of
  pages you pasted a clip into.
- Aggregate stats (e.g. top source sites and paste destinations).
- Your settings (retention period, privacy toggles, blocked-site list).

## What MemClip does NOT do

- **No data ever leaves your device.** MemClip has no servers, no analytics, no
  telemetry, and makes no network requests. Nothing is uploaded or shared.
- **No account, no tracking, no advertising.**
- MemClip does not use `chrome.storage.sync`, so your clips are not synced to
  your browser account.

## Privacy & security protections

MemClip is designed to avoid capturing sensitive information:

- **Sensitive-data skip (on by default):** content that looks like a credit-card
  number (Luhn-validated), a US Social Security Number, a private key block, or
  a known API/secret token (AWS, GitHub, OpenAI, Slack, Google) is **not stored**.
- **Password fields skipped (on by default):** copies and pastes made inside an
  `<input type="password">` are ignored.
- **Incognito excluded (default):** MemClip does not capture in incognito/private
  windows unless you explicitly opt in.
- **Per-site blocklist:** you can list hostnames that MemClip should never
  capture on (matches subdomains too).

These can be configured in **Settings → Privacy & Security**.

## Your controls

- **Retention:** automatically delete clips older than 30/60/90 days, or keep
  them forever. Configurable in Settings.
- **Clear All History:** removes all clips except pinned ones.
- **Erase Everything:** permanently deletes all clips (including pinned), stats,
  and settings.
- Delete any individual clip from its detail view.

## Permissions and why they're needed

- `storage` — to save your clip history locally on your device.
- `tabs` — to read the title/URL of the page for clip context and to open a
  clip's source page when you ask.
- `clipboardRead` — to capture text from "copy" buttons and programmatic copies
  that don't expose a text selection.
- `host_permissions: <all_urls>` — the content script must run on the pages you
  use in order to detect copy/paste there. It is used only for capture; no page
  content other than what you copy/paste is collected.

## Contact

This is a local-only utility. For questions or issues, refer to the project's
support channel listed on its store page.
