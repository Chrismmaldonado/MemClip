// Builds an Opera-specific zip. Identical to the normal build, except the
// command's default keyboard shortcut is removed: Opera's add-on validator
// rejects punctuation keys (e.g. "Ctrl+Period") that Chrome/Edge/Firefox accept.
// The toolbar icon still opens MemClip, and users can assign their own shortcut
// at opera://extensions/shortcuts.
// Run with:  npm run build:opera
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
const version = manifest.version || '0.0.0';

if (manifest.commands && manifest.commands['toggle-memclip']) {
  delete manifest.commands['toggle-memclip'].suggested_key;
}

const INCLUDE = [
  'background.js',
  'content.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'icons',
  '_locales'
];

const STAGE = path.join(DIST, 'memclip-opera');
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

function copy(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const entry of fs.readdirSync(src)) copy(path.join(src, entry), path.join(dest, entry));
  } else {
    fs.copyFileSync(src, dest);
  }
}

let missing = [];
for (const item of INCLUDE) {
  const src = path.join(ROOT, item);
  if (!fs.existsSync(src)) { missing.push(item); continue; }
  copy(src, path.join(STAGE, item));
}
if (missing.length) {
  console.error('ERROR: missing required files:', missing.join(', '));
  process.exit(1);
}

fs.writeFileSync(path.join(STAGE, 'manifest.json'), JSON.stringify(manifest, null, 2));

const zipName = `memclip-v${version}-opera.zip`;
const zipPath = path.join(DIST, zipName);
fs.rmSync(zipPath, { force: true });

if (process.platform === 'win32') {
  const ps = [
    'Add-Type -AssemblyName System.IO.Compression',
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$src = '${STAGE}'`,
    `$zip = '${zipPath}'`,
    'if (Test-Path $zip) { Remove-Item $zip }',
    "$a = [System.IO.Compression.ZipFile]::Open($zip, 'Create')",
    'Get-ChildItem -Path $src -Recurse -File | ForEach-Object {',
    "  $rel = $_.FullName.Substring($src.Length + 1).Replace('\\','/')",
    '  [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($a, $_.FullName, $rel)',
    '}',
    '$a.Dispose()'
  ].join('; ');
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { stdio: 'inherit' });
} else {
  execFileSync('zip', ['-r', '-q', zipPath, '.'], { cwd: STAGE, stdio: 'inherit' });
}

const kb = (fs.statSync(zipPath).size / 1024).toFixed(1);
console.log(`\nBuilt ${zipName} (${kb} KB) at dist/`);
console.log('Upload this zip to the Opera Add-ons dashboard.');
