// Generates a 300x188 promotional image for the Opera Add-ons listing,
// using MemClip branding (logo + name + tagline) on the site's dark theme.
// Run with:  node scripts/make-promo.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const logo = fs.readFileSync(path.join(ROOT, 'icons', 'icon128.png')).toString('base64');
const out = path.join(ROOT, 'store-assets', 'opera-promo-300x188.png');

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:300px;height:188px;overflow:hidden}
  body{
    font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;
    background:radial-gradient(220px 140px at 22% 18%, rgba(51,255,119,.18), transparent 70%), #06100a;
    color:#eafff1; display:flex; flex-direction:column; justify-content:center;
    padding:22px 24px; position:relative;
  }
  .row{display:flex;align-items:center;gap:14px}
  .logo{width:54px;height:54px;border-radius:12px;box-shadow:0 0 18px rgba(51,255,119,.5)}
  .name{font-size:34px;font-weight:800;letter-spacing:-.5px;color:#eafff1;text-shadow:0 0 18px rgba(51,255,119,.35)}
  .tag{margin-top:16px;font-size:14.5px;line-height:1.35;color:#9be8b4;max-width:250px}
  .pill{margin-top:14px;display:inline-block;font-size:11px;font-weight:700;letter-spacing:.12em;
    text-transform:uppercase;color:#33ff77;border:1px solid rgba(51,255,119,.5);border-radius:999px;padding:4px 11px}
</style></head><body>
  <div class="row">
    <img class="logo" src="data:image/png;base64,${logo}" alt="">
    <div class="name">MemClip</div>
  </div>
  <div class="tag">Clipboard history that remembers what you copied and where you pasted it.</div>
  <div><span class="pill">Private &middot; Local &middot; Free</span></div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 300, height: 188 }, deviceScaleFactor: 1 });
await page.setContent(html, { waitUntil: 'networkidle' });
await page.screenshot({ path: out });
await browser.close();
console.log('wrote ' + out);
