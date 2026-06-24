# MemClip — Store Listing Copy

Copy/paste-ready text for each store. Replace anything in `{{double braces}}` with
your real values before submitting.

**Placeholders to fill in once:**
- `{{SUPPORT_EMAIL}}` — ✅ set to `getmemclip@gmail.com`
- `{{LANDING_URL}}` — ✅ set to `https://chrismmaldonado.github.io/MemClip/`
- `{{PRIVACY_URL}}` — ✅ set to `https://chrismmaldonado.github.io/MemClip/privacy.html`
- `{{DEVELOPER_NAME}}` — ✅ set to `MemClip`

---

## Name
MemClip — Clipboard History

## Summary / short description (≤132 chars, Chrome)
Private clipboard history that remembers what you copied, where it came from, and where you pasted it. No account, all local.

## Categories
- Chrome: **Productivity**
- Edge: **Productivity**
- Firefox tags: `clipboard`, `productivity`, `clipboard-manager`, `history`, `privacy`

## Detailed description

**Never lose a copy again.**

MemClip keeps a searchable history of everything you copy — text, links, emails, and code — and remembers the context around it: the page you copied it from, when, and every place you later pasted it.

**Why MemClip**
- 📋 **Full clipboard history** — automatically saves what you copy on any site.
- 🔎 **Fast fuzzy search + filters** — find any clip by content, type (text/link/email/code), or date.
- 🧭 **Source & paste tracking** — see where each clip came from and everywhere you pasted it.
- 📌 **Pin & reorder** — keep your go-to snippets at the top; drag to arrange.
- 🎨 **Syntax-highlighted code** and type-aware actions (open links, compose emails).
- 💾 **Export / import** — back up or move your whole history as a JSON file.
- ⌨️ **Keyboard shortcut** — `Ctrl + .` to open instantly (fully customizable).

**Private by design**
- 🔒 **100% local.** No account, no servers, no analytics, no network requests — your data never leaves your device.
- 🛡️ **Skips common secrets** by default: credit-card numbers, SSNs, private keys, and well-known API-token formats are skipped before anything is stored.
- 🙈 **Skips password fields** and **incognito** windows (opt-in if you want it).
- 🚫 **Per-site blocklist** for sites MemClip should never touch.
- 🗑️ Full control: per-clip delete, clear history (keep pins), or erase everything.

Open MemClip from the toolbar or with `Ctrl + .` (you can change the shortcut in your browser's extension settings).

Questions or feedback: getmemclip@gmail.com

## Permission justifications (paste into the review forms)
- **storage** — saves your clip history locally on your device.
- **tabs** — reads the title/URL of the current page so each clip has source context, and opens a clip's source page when you ask.
- **clipboardRead** — captures text from "copy" buttons and programmatic copies that don't expose a text selection.
- **host_permissions `<all_urls>`** — the content script must run on the pages you use to detect copy/paste events. It is used only for capture; no page content other than what you copy/paste is collected. **Nothing is transmitted off-device.**

## Single purpose (Chrome Web Store field)
MemClip maintains a local, searchable history of the user's clipboard copies and pastes, with the source and destination context for each item.

## Privacy
- Privacy policy URL: https://chrismmaldonado.github.io/MemClip/privacy.html
- Data collected: **None transmitted.** All clip data is stored locally via `chrome.storage.local` and never leaves the device.
- Firefox data-collection declaration: **No data collected** (manifest declares `data_collection_permissions: { required: ["none"] }`).

## Support / homepage
- Homepage: https://chrismmaldonado.github.io/MemClip/
- Support email: getmemclip@gmail.com
- Developer: MemClip

## Screenshots (in `store-assets/`)
1. `01-history.png` — clipboard history with search & filters
2. `02-detail.png` — clip detail: source, highlighted code, paste tracking
3. `03-privacy.png` — privacy settings + backup

(All 1280×800; regenerate any time with `node test/store-screenshots.mjs`.)
