# MemClip — Launch / Submission Checklist

Everything needed to publish MemClip to the stores. Work top to bottom.

## 0. One-time setup decisions
- [ ] Final extension name: **MemClip — Clipboard History**
- [ ] Support email: `{{SUPPORT_EMAIL}}`
- [ ] Developer / publisher name: `{{DEVELOPER_NAME}}`
- [ ] GitHub repo (for Pages hosting): `{{REPO}}`
- [ ] Confirm gecko id in `manifest.json` (`memclip@memclip.app`) — change if you own a domain.

## 1. Host the landing page + privacy policy (free, GitHub Pages)
The `docs/` folder is a ready-to-publish site.
- [ ] Push the project to GitHub.
- [ ] Repo → **Settings → Pages** → Source: **Deploy from branch**, branch `main`, folder **/docs**.
- [ ] Note the URLs (usually):
  - Landing: `https://{{github-user}}.github.io/{{repo}}/`
  - Privacy: `https://{{github-user}}.github.io/{{repo}}/privacy.html`
- [ ] In `docs/privacy.html` replace `{{SUPPORT_EMAIL}}`.
- [ ] In `docs/index.html` replace the three store button `href="#"` with real store URLs once live.

## 2. Build the package
```
npm run build
```
Produces `dist/memclip-v<version>.zip` (runtime files only, forward-slash paths, manifest at root).
- [ ] Verify zip built and is ~50–60 KB.

## 3. Prepare listing assets
- [ ] Store copy: see `STORE_LISTING.md` (fill placeholders).
- [ ] Screenshots: `store-assets/01-history.png`, `02-detail.png`, `03-privacy.png` (1280×800). Regenerate with `npm run screenshots`.
- [ ] Icon: `icons/icon128.png` (already in the build).
- [ ] (Optional) Chrome small promo tile 440×280 — can crop from a screenshot later; not required to publish.

## 4. Chrome Web Store  ($5 one-time dev fee)
- [ ] Register at the Chrome Web Store Developer Dashboard, pay the one-time $5.
- [ ] Create item → upload `dist/memclip-v1.0.0.zip`.
- [ ] Fill: description (STORE_LISTING.md), category **Productivity**, language English.
- [ ] Upload screenshots + 128px icon.
- [ ] **Privacy tab:** set single purpose, justify each permission (text in STORE_LISTING.md), declare **no data collected/transmitted**, add privacy policy URL.
- [ ] Submit for review.

## 5. Microsoft Edge Add-ons  (free)
- [ ] Register at Partner Center (Edge program).
- [ ] New extension → upload the **same zip**.
- [ ] Fill listing (reuse STORE_LISTING.md), screenshots, privacy URL.
- [ ] Submit.

## 6. Firefox AMO  (free)
- [ ] Sign in at addons.mozilla.org → Developer Hub → Submit a New Add-on.
- [ ] Upload the **same zip**. (Manifest already has `browser_specific_settings.gecko` + `data_collection_permissions`.)
- [ ] Pre-validation runs automatically; our `web-ext lint` shows **0 errors** (warnings are benign — service-worker-ignored-by-design, guarded `windows.onBoundsChanged`, sanitized `innerHTML`).
- [ ] Set listing copy + privacy URL. Submit.
- [ ] (Optional) Local smoke test before submitting: `npx web-ext run` to launch Firefox with the extension loaded.

## 7. Opera Add-ons  (free, optional)
- [ ] Opera publisher account → upload the same zip. (Opera is Chromium-based; the package is identical.)

## 8. After approval
- [ ] Update `docs/index.html` store buttons with the live URLs; redeploy Pages.
- [ ] Ask early users for reviews (single biggest install driver).
- [ ] Plan the launch posts (same day): Product Hunt, Reddit (r/chrome_extensions, r/productivity), Show HN.

## 9. Releasing updates later
- [ ] Bump `version` in `manifest.json`.
- [ ] `npm test` (must be green) → `npm run build`.
- [ ] Upload the new zip to each dashboard.

---

### Quality gates (all currently passing)
- `npm test` → 33 unit/integration/manifest tests
- `npm run test:browser` → 18 real-Chromium checks
- `npx web-ext lint --source-dir dist/memclip` → 0 errors, 0 notices
