import { chromium } from 'playwright';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const target = process.argv[2] || 'docs/index.html';
const out = process.argv[3] || 'docs/landing-preview.png';
const file = pathToFileURL(resolve(target)).href;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 });
await page.goto(file, { waitUntil: 'networkidle' });
await page.screenshot({ path: out, fullPage: true });
await browser.close();
console.log('wrote ' + out);
