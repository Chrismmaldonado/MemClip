// Cross-browser manifest + i18n wiring validation (Phase 4).
// Run with:  node --test test/manifest.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

function read(p) { return fs.readFileSync(path.join(ROOT, p), 'utf8'); }
const manifest = JSON.parse(read('manifest.json'));
const messages = JSON.parse(read('_locales/en/messages.json'));

test('manifest is MV3 with required identity keys', () => {
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.version, 'version present');
  assert.equal(manifest.default_locale, 'en');
});

test('background declares both service_worker (Chromium) and scripts (Firefox)', () => {
  assert.ok(manifest.background, 'background present');
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.ok(Array.isArray(manifest.background.scripts), 'scripts array present for Firefox');
  assert.ok(manifest.background.scripts.includes('background.js'));
});

test('Firefox browser_specific_settings.gecko.id is set', () => {
  assert.ok(manifest.browser_specific_settings, 'browser_specific_settings present');
  assert.ok(manifest.browser_specific_settings.gecko, 'gecko present');
  assert.ok(manifest.browser_specific_settings.gecko.id, 'gecko.id present');
  const dc = manifest.browser_specific_settings.gecko.data_collection_permissions;
  assert.ok(dc && Array.isArray(dc.required), 'data_collection_permissions.required present');
});

test('every __MSG_x__ used in manifest exists in the locale file', () => {
  const raw = read('manifest.json');
  const refs = [...raw.matchAll(/__MSG_([A-Za-z0-9_]+)__/g)].map(m => m[1]);
  assert.ok(refs.length >= 2, 'manifest uses i18n messages');
  refs.forEach(key => {
    assert.ok(messages[key], 'missing message for __MSG_' + key + '__');
    assert.ok(messages[key].message, 'empty message for ' + key);
  });
});

test('every data-i18n key in popup.html exists in the locale file', () => {
  const html = read('popup.html');
  const keys = [
    ...[...html.matchAll(/data-i18n="([^"]+)"/g)].map(m => m[1]),
    ...[...html.matchAll(/data-i18n-placeholder="([^"]+)"/g)].map(m => m[1]),
    ...[...html.matchAll(/data-i18n-title="([^"]+)"/g)].map(m => m[1])
  ];
  assert.ok(keys.length > 5, 'popup uses i18n keys');
  keys.forEach(key => {
    assert.ok(messages[key], 'missing message for data-i18n="' + key + '"');
    assert.ok(messages[key].message, 'empty message for ' + key);
  });
});

test('all locale messages are well-formed', () => {
  Object.keys(messages).forEach(key => {
    assert.equal(typeof messages[key].message, 'string', key + ' has a string message');
    assert.ok(messages[key].message.length > 0, key + ' message non-empty');
  });
});
