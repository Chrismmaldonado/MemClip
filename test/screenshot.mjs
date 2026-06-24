// Visual check: load the popup with seeded clips and screenshot key views.
import { chromium } from 'playwright';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = EXT_DIR;
const userDataDir = path.join(os.tmpdir(), 'memclip-shot-' + Date.now());

const context = await chromium.launchPersistentContext(userDataDir, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--no-first-run',
    '--window-position=-2400,-2400']
});

let sw = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 20000 });
const extId = new URL(sw.url()).host;

await sw.evaluate(() => new Promise((res) => {
  const now = Date.now();
  const hist = [
    { id: 'a', text: 'https://github.com/cursor/cursor', hostname: 'github.com', source: 'https://github.com/x', pageTitle: 'GitHub', timestamp: now, type: 'url', pinned: true, pinRank: 0, copyCount: 3, pasteCount: 2, pastedTo: [{hostname:'docs.google.com',timestamp:now-1000}] },
    { id: 'b', text: 'function greet(name) {\n  const msg = "hello " + name; // friendly\n  return msg;\n}', hostname: 'stackoverflow.com', source: 'https://stackoverflow.com/q', pageTitle: 'SO', timestamp: now-5000, type: 'code', pinned: true, pinRank: 1, copyCount: 1, pasteCount: 0, pastedTo: [] },
    { id: 'c', text: 'design.team@company.com', hostname: 'mail.google.com', source: 'https://mail.google.com', pageTitle: 'Mail', timestamp: now-60000, type: 'email', pinned: false, copyCount: 1, pasteCount: 1, pastedTo: [] },
    { id: 'd', text: 'The quick brown fox jumps over the lazy dog and keeps on running into the night.', hostname: 'en.wikipedia.org', source: 'https://en.wikipedia.org/wiki/Fox', pageTitle: 'Fox', timestamp: now-3600000, type: 'text', pinned: false, copyCount: 2, pasteCount: 0, pastedTo: [] },
    { id: 'e', text: 'npm install --save-dev playwright', hostname: 'npmjs.com', source: 'https://npmjs.com', pageTitle: 'npm', timestamp: now-7200000, type: 'code', pinned: false, copyCount: 1, pasteCount: 4, pastedTo: [] }
  ];
  chrome.storage.local.set({ memclip_history: hist }, () => res(true));
}));

const popup = await context.newPage();
await popup.setViewportSize({ width: 420, height: 620 });
await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load' });
await popup.waitForTimeout(900); // let reveal animations settle

await popup.screenshot({ path: path.join(OUT, 'phase3_main.png') });

// Detail of the code clip (shows highlight + type actions).
await popup.evaluate(() => {
  const items = [...document.querySelectorAll('#clips-list .clip-item')];
  const code = items.find((it) => it.getAttribute('data-id') === 'b');
  code.querySelector('[data-action="info"]').click();
});
await popup.waitForTimeout(700);
await popup.screenshot({ path: path.join(OUT, 'phase3_detail_code.png') });

// Settings view (privacy + theme).
await popup.evaluate(() => document.getElementById('detail-back').click());
await popup.waitForTimeout(200);
await popup.evaluate(() => document.getElementById('settings-btn').click());
await popup.waitForTimeout(700);
await popup.screenshot({ path: path.join(OUT, 'phase3_settings.png') });

console.log('screenshots written:', ['phase3_main.png', 'phase3_detail_code.png', 'phase3_settings.png'].join(', '));
await context.close();
process.exit(0);
