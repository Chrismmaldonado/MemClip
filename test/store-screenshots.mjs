// Generate store-ready 1280x800 screenshots: captures the real popup, then
// frames it on a branded canvas (caption + device shadow) and re-screenshots.
// No image libraries needed — the popup PNG is inlined as a data URL.
// Run with:  node test/store-screenshots.mjs
import { chromium } from 'playwright';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(EXT_DIR, 'store-assets');
fs.mkdirSync(OUT, { recursive: true });

const userDataDir = path.join(os.tmpdir(), 'memclip-store-' + Date.now());
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
await popup.setViewportSize({ width: 400, height: 680 });
await popup.goto(`chrome-extension://${extId}/popup.html`, { waitUntil: 'load' });
await popup.waitForTimeout(900);

const framer = await context.newPage();
await framer.setViewportSize({ width: 1280, height: 800 });

function frameHtml(headline, sub, b64) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:1280px;height:800px;overflow:hidden;font-family:-apple-system,'Segoe UI',Roboto,sans-serif}
    .stage{width:1280px;height:800px;display:flex;align-items:center;justify-content:center;gap:72px;
      background:radial-gradient(1100px 520px at 28% -5%, rgba(51,255,119,0.12), transparent 60%), #06100a;}
    .copy{max-width:430px}
    .badge{display:inline-block;margin-bottom:24px;padding:7px 14px;border:1px solid rgba(51,255,119,.45);
      border-radius:999px;color:#33ff77;font-size:13px;letter-spacing:.16em;text-transform:uppercase;
      font-weight:600;text-shadow:0 0 12px rgba(51,255,119,.5)}
    .copy h1{font-size:48px;line-height:1.08;font-weight:750;color:#eafff1;letter-spacing:-.5px;
      text-shadow:0 0 22px rgba(51,255,119,.22)}
    .copy p{margin-top:20px;font-size:21px;line-height:1.5;color:#8fd6a8}
    .device{border:1px solid rgba(51,255,119,.28);border-radius:16px;overflow:hidden;background:#000;
      box-shadow:0 34px 90px rgba(0,0,0,.65), 0 0 46px rgba(51,255,119,.14)}
    .device img{display:block;width:380px;height:auto}
  </style></head><body>
    <div class="stage">
      <div class="copy"><span class="badge">MemClip</span><h1>${headline}</h1><p>${sub}</p></div>
      <div class="device"><img src="data:image/png;base64,${b64}"></div>
    </div></body></html>`;
}

async function shot(name, headline, sub) {
  const buf = await popup.screenshot();
  await framer.setContent(frameHtml(headline, sub, buf.toString('base64')), { waitUntil: 'load' });
  await framer.waitForTimeout(250);
  await framer.screenshot({ path: path.join(OUT, name) });
  console.log('wrote', name);
}

// 1) Main list
await shot('01-history.png', 'Your clipboard,<br>remembered.', 'Every copy is saved with its source — searchable, pinnable, and always one click from your next paste.');

// 2) Code clip detail (highlight + paste tracking + type actions)
await popup.evaluate(() => {
  const items = [...document.querySelectorAll('#clips-list .clip-item')];
  const code = items.find((it) => it.getAttribute('data-id') === 'b');
  code.querySelector('[data-action="info"]').click();
});
await popup.waitForTimeout(700);
await shot('02-detail.png', 'Know where it<br>came from & went.', 'See the source page, syntax-highlighted code, and everywhere you pasted each clip.');

// 3) Settings (privacy)
await popup.evaluate(() => document.getElementById('detail-back').click());
await popup.waitForTimeout(200);
await popup.evaluate(() => document.getElementById('settings-btn').click());
await popup.waitForTimeout(700);
await shot('03-privacy.png', 'Private by<br>default.', 'Skips passwords, cards & secrets. No account, no servers, no tracking — everything stays on your device.');

console.log('store screenshots written to', OUT);
await context.close();
process.exit(0);
