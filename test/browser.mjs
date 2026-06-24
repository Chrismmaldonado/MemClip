// Real-browser end-to-end test: loads the actual MemClip extension into
// Chromium (the engine Opera is built on), performs a real copy on an HTTP
// page, and verifies the clip lands in chrome.storage AND renders in the real
// popup.html. Run with:  node test/browser.mjs
import { chromium } from 'playwright';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MARKER = 'HELLO_MEMCLIP_' + Date.now();

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html');
      res.end(`<!doctype html><html><body>
        <p id="t">${MARKER}</p>
        <input id="box" />
      </body></html>`);
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function log(...a) { console.log('[browser-test]', ...a); }
let failures = 0;
function check(name, cond) {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name);
  if (!cond) failures++;
}

const server = await startServer();
const port = server.address().port;
const url = `http://127.0.0.1:${port}/`;
const userDataDir = path.join(os.tmpdir(), 'memclip-pw-' + Date.now());

// Extensions only load in headed Chromium (or new-headless). Use headed.
const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  acceptDownloads: true,
  args: [
    `--disable-extensions-except=${EXT_DIR}`,
    `--load-extension=${EXT_DIR}`,
    '--no-first-run',
    '--window-position=-2400,-2400',
    '--window-size=500,600'
  ]
});

try {
  // Get the MV3 service worker → extension id (poll + event).
  let sw = context.serviceWorkers()[0];
  if (!sw) {
    const deadline = Date.now() + 20000;
    while (!sw && Date.now() < deadline) {
      sw = context.serviceWorkers()[0];
      if (sw) break;
      try { sw = await context.waitForEvent('serviceworker', { timeout: 3000 }); } catch (e) {}
    }
  }
  if (!sw) throw new Error('extension service worker never registered');
  const extId = new URL(sw.url()).host;
  log('extension id:', extId);

  const page = await context.newPage();
  const consoleLines = [];
  page.on('console', (m) => { const t = m.text(); if (t.includes('MemClip')) consoleLines.push(t); });
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(500); // let document_start content script attach

  // Perform a real copy: select the paragraph and copy it.
  await page.evaluate(() => {
    const el = document.getElementById('t');
    const r = document.createRange();
    r.selectNodeContents(el);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    document.execCommand('copy');
  });
  await page.waitForTimeout(800);

  log('content-script logs seen:', consoleLines.length);
  consoleLines.slice(0, 8).forEach((l) => log('  page:', l));

  // 1) Did the clip land in chrome.storage (read from the service worker)?
  const history = await sw.evaluate(() => new Promise((res) => {
    chrome.storage.local.get('memclip_history', (d) => res(d.memclip_history || []));
  }));
  check('clip saved to chrome.storage', Array.isArray(history) && history.some((c) => c.text && c.text.includes(MARKER)));
  log('history length:', history.length, '| top:', history[0] && JSON.stringify(history[0].text));

  // 2) Does the real popup.html render the clip under "All"?
  const popup = await context.newPage();
  const popupErrors = [];
  popup.on('pageerror', (e) => popupErrors.push(String(e)));
  await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load' });
  let rendered = false;
  try {
    await popup.waitForFunction((marker) => {
      const l = document.getElementById('clips-list');
      return !!(l && l.textContent && l.textContent.includes(marker));
    }, MARKER, { timeout: 8000 });
    rendered = true;
  } catch (e) {
    rendered = false;
  }
  check('popup renders the clip under All', rendered);
  if (!rendered) {
    const dump = await popup.evaluate(() => {
      const l = document.getElementById('clips-list');
      return l ? l.textContent.slice(0, 300) : '(no #clips-list)';
    });
    log('clips-list content was:', JSON.stringify(dump));
  }

  // 3) Paste tracking: paste the copied text into an input and confirm the
  // clip's pasteCount is recorded.
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url });
  await page.bringToFront();
  await page.click('#box');
  await page.keyboard.down('Control');
  await page.keyboard.press('KeyV');
  await page.keyboard.up('Control');
  await page.waitForTimeout(800);

  const afterPaste = await sw.evaluate((marker) => new Promise((res) => {
    chrome.storage.local.get('memclip_history', (d) => {
      const list = d.memclip_history || [];
      const clip = list.find((c) => c.text && c.text.includes(marker));
      res(clip ? { pasteCount: clip.pasteCount || 0, pastedTo: clip.pastedTo || [] } : null);
    });
  }), MARKER);
  log('after paste:', JSON.stringify(afterPaste));
  check('paste is tracked on the clip (pasteCount >= 1)', !!(afterPaste && afterPaste.pasteCount >= 1));

  // 4) Sensitive data (Luhn-valid credit card) must NOT be captured.
  await page.evaluate(() => {
    const p = document.createElement('p');
    p.id = 'cc';
    p.textContent = '4111 1111 1111 1111';
    document.body.appendChild(p);
    const r = document.createRange();
    r.selectNodeContents(p);
    const s = window.getSelection();
    s.removeAllRanges();
    s.addRange(r);
    document.execCommand('copy');
  });
  await page.waitForTimeout(700);
  const hist2 = await sw.evaluate(() => new Promise((res) => {
    chrome.storage.local.get('memclip_history', (d) => res(d.memclip_history || []));
  }));
  const cardStored = hist2.some((c) => (c.text || '').replace(/[\s-]/g, '') === '4111111111111111');
  check('sensitive credit-card number is NOT stored', !cardStored);

  // Helper: copy arbitrary text via a real selection + execCommand('copy').
  async function doCopy(text) {
    await page.evaluate((t) => {
      let el = document.getElementById('cpy');
      if (!el) { el = document.createElement('p'); el.id = 'cpy'; document.body.appendChild(el); }
      el.textContent = t;
      const r = document.createRange();
      r.selectNodeContents(el);
      const s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      document.execCommand('copy');
    }, text);
    await page.waitForTimeout(500);
  }
  async function historyHas(text) {
    const h = await sw.evaluate(() => new Promise((res) => {
      chrome.storage.local.get('memclip_history', (d) => res(d.memclip_history || []));
    }));
    return h.some((c) => c.text === text);
  }
  async function writeSettings(s) {
    await sw.evaluate((val) => new Promise((res) => {
      chrome.storage.local.set({ memclip_settings: val }, () => res(true));
    }), s);
    await page.waitForTimeout(250); // let content.js hot-reload settings via onChanged
  }

  // 5) With DEFAULT settings present, a normal copy must still be captured.
  await writeSettings({ ignoreSensitive: true, skipPasswordFields: true, captureIncognito: false, denylist: [] });
  const okText = 'DEFAULTS_OK_' + Date.now();
  await doCopy(okText);
  check('normal copy still captured with default settings present', await historyHas(okText));

  // 6) With the current host on the denylist, copy must be blocked (this is the
  //    likely cause of "copy stopped working" if a site was added).
  await writeSettings({ ignoreSensitive: true, skipPasswordFields: true, captureIncognito: false, denylist: ['127.0.0.1'] });
  const denyText = 'DENY_' + Date.now();
  await doCopy(denyText);
  check('copy is blocked when site is on denylist', !(await historyHas(denyText)));

  // 7) Removing the denylist restores capture.
  await writeSettings({ ignoreSensitive: true, skipPasswordFields: true, captureIncognito: false, denylist: [] });
  const restoreText = 'RESTORED_' + Date.now();
  await doCopy(restoreText);
  check('copy works again after clearing denylist', await historyHas(restoreText));

  // ===================== Phase 3: UI polish features =====================

  // Seed a clean, known set of clips of different types via the service worker.
  await sw.evaluate(() => new Promise((res) => {
    const now = Date.now();
    const hist = [
      { id: 'p3url', text: 'https://example.com/page', hostname: 'example.com', source: 'https://a.com', pageTitle: 'A', timestamp: now, type: 'url', pinned: false, copyCount: 1, pasteCount: 0, pastedTo: [] },
      { id: 'p3mail', text: 'someone@example.com', hostname: 'a.com', source: 'https://a.com', pageTitle: 'A', timestamp: now - 1, type: 'email', pinned: false, copyCount: 1, pasteCount: 0, pastedTo: [] },
      { id: 'p3code', text: 'function hi(){ return 42; }', hostname: 'a.com', source: 'https://a.com', pageTitle: 'A', timestamp: now - 2, type: 'code', pinned: false, copyCount: 1, pasteCount: 0, pastedTo: [] },
      { id: 'p3text', text: 'just plain words here', hostname: 'a.com', source: 'https://a.com', pageTitle: 'A', timestamp: now - 3, type: 'text', pinned: false, copyCount: 1, pasteCount: 0, pastedTo: [] }
    ];
    chrome.storage.local.set({ memclip_history: hist }, () => res(true));
  }));

  // Reload popup so it picks up the seeded set fresh.
  await popup.reload({ waitUntil: 'load' });
  await popup.waitForTimeout(400);

  // 8) Theme applied — accent resolves to the terminal green we configured.
  const accent = await popup.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--accent').trim()
  );
  check('matrix theme accent is terminal green (#33ff77)', accent.toLowerCase() === '#33ff77');

  // 8b) i18n: chrome.i18n resolves messages and the DOM was localized.
  const i18nInfo = await popup.evaluate(() => ({
    ext: (chrome.i18n && chrome.i18n.getMessage) ? chrome.i18n.getMessage('extName') : null,
    tab: document.querySelector('.tab[data-tab="all"]') && document.querySelector('.tab[data-tab="all"]').textContent.trim(),
    ph: document.getElementById('search-input') && document.getElementById('search-input').getAttribute('placeholder')
  }));
  check('i18n: getMessage(extName) === "MemClip"', i18nInfo.ext === 'MemClip');
  check('i18n: localized tab + placeholder present', i18nInfo.tab === 'All' && /Search clips/.test(i18nInfo.ph || ''));

  // 9) Type filter: clicking "Link" shows only the url clip.
  await popup.evaluate(() => {
    const chip = [...document.querySelectorAll('.filter-chip')].find((c) => c.dataset.type === 'url');
    chip.click();
  });
  await popup.waitForTimeout(300);
  const linkOnly = await popup.evaluate(() => {
    const items = [...document.querySelectorAll('#clips-list .clip-item .clip-text')];
    return items.map((n) => n.textContent);
  });
  check('type filter (Link) shows only url clips',
    linkOnly.length === 1 && linkOnly[0].includes('example.com/page'));

  // Reset filter back to All.
  await popup.evaluate(() => {
    const chip = [...document.querySelectorAll('.filter-chip')].find((c) => c.dataset.type === 'all');
    chip.click();
  });
  await popup.waitForTimeout(300);

  // 10) Fuzzy search: a subsequence query ("plnwrds") still finds "plain words".
  await popup.evaluate(() => {
    const s = document.getElementById('search-input');
    s.value = 'plnwrds';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await popup.waitForTimeout(400);
  const fuzzyHit = await popup.evaluate(() => {
    const items = [...document.querySelectorAll('#clips-list .clip-item .clip-text')];
    return items.some((n) => n.textContent.includes('plain words'));
  });
  check('fuzzy search finds "plain words" from subsequence "plnwrds"', fuzzyHit);
  await popup.evaluate(() => {
    const s = document.getElementById('search-input');
    s.value = '';
    s.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await popup.waitForTimeout(300);

  // 11) Type-aware action: the url clip's detail shows an "Open link" button.
  await popup.evaluate(() => {
    const items = [...document.querySelectorAll('#clips-list .clip-item')];
    const urlItem = items.find((it) => it.getAttribute('data-id') === 'p3url');
    urlItem.querySelector('[data-action="info"]').click();
  });
  await popup.waitForTimeout(400);
  const hasOpenLink = await popup.evaluate(() =>
    !!document.querySelector('#detail-content .detail-actions [data-act="open-url"]')
  );
  check('detail view shows type-aware "Open link" action for url clip', hasOpenLink);

  // 11a) Citation feature: the detail view offers source-attributed cite
  // actions, and clicking one copies a citation that embeds the source.
  const citeButtons = await popup.evaluate(() =>
    [...document.querySelectorAll('#detail-content [data-cite]')].map((b) => b.getAttribute('data-cite'))
  );
  check('detail shows cite actions (markdown/plain/link)',
    citeButtons.includes('markdown') && citeButtons.includes('plain') && citeButtons.includes('link'));

  const citation = await popup.evaluate(async () => {
    let captured = null;
    const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = (s) => { captured = s; try { return orig(s); } catch (e) { return Promise.resolve(); } };
    document.querySelector('#detail-content [data-cite="markdown"]').click();
    await new Promise((r) => setTimeout(r, 150));
    return captured;
  });
  log('markdown citation:', JSON.stringify(citation));
  check('markdown citation embeds source link [A](https://a.com)',
    typeof citation === 'string' && citation.includes('[A](https://a.com)') && citation.includes('> https://example.com/page'));

  // Back to main.
  await popup.evaluate(() => document.getElementById('detail-back').click());
  await popup.waitForTimeout(300);

  // 11b) Export/Import round-trip (Phase 5 backup).
  await popup.evaluate(() => document.getElementById('settings-btn').click());
  await popup.waitForTimeout(300);
  const [download] = await Promise.all([
    popup.waitForEvent('download'),
    popup.evaluate(() => document.getElementById('export-btn').click())
  ]);
  const dlPath = await download.path();
  let exportOk = false, exportedClips = 0;
  try {
    const parsed = JSON.parse(fs.readFileSync(dlPath, 'utf8'));
    exportedClips = (parsed.clips || []).length;
    exportOk = parsed.app === 'MemClip' && Array.isArray(parsed.clips) && exportedClips > 0;
  } catch (e) {}
  check('export produces valid MemClip JSON with clips', exportOk);

  // Wipe history via the service worker, then import the file back (merge).
  await sw.evaluate(() => new Promise((res) => {
    chrome.storage.local.set({ memclip_history: [] }, () => res(true));
  }));
  popup.once('dialog', (d) => d.accept()); // OK = merge
  await popup.setInputFiles('#import-file', dlPath);
  await popup.waitForTimeout(900);
  const afterImport = await sw.evaluate(() => new Promise((res) => {
    chrome.storage.local.get('memclip_history', (d) => res((d.memclip_history || []).length));
  }));
  check('import restores clips from backup file', afterImport === exportedClips && exportedClips > 0);

  // 12) Multi-select bulk delete: select-all then delete removes them.
  popup.on('dialog', (d) => d.accept());
  await popup.evaluate(() => document.getElementById('select-btn').click());
  await popup.waitForTimeout(300);
  await popup.evaluate(() => {
    document.querySelectorAll('#clips-list .clip-check input').forEach((cb) => {
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
  });
  await popup.waitForTimeout(200);
  await popup.evaluate(() => document.getElementById('select-delete').click());
  await popup.waitForTimeout(600);
  const remaining = await sw.evaluate(() => new Promise((res) => {
    chrome.storage.local.get('memclip_history', (d) => res((d.memclip_history || []).length));
  }));
  check('multi-select bulk delete removed all selected clips', remaining === 0);

  // 13) No uncaught errors in the redesigned popup.
  check('popup has no uncaught JS errors', popupErrors.length === 0);
  if (popupErrors.length) log('popup errors:', popupErrors.join(' | '));
} catch (err) {
  console.log('FAIL - test harness error:', err && err.stack || err);
  failures++;
} finally {
  await context.close();
  server.close();
}

console.log(failures === 0 ? '\nALL BROWSER TESTS PASSED' : `\n${failures} BROWSER TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
