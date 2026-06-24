// Tests for the background service worker's storage layer.
// Run with:  node --test   (from the memclip folder)

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { createMockChrome, byteSize } = require('./mock-chrome.js');

// background.js touches `chrome` at load time, so a mock must exist before
// require. The exported functions read the *global* `chrome` at call time, so
// swapping global.chrome per test gives each test a fresh storage.
global.chrome = createMockChrome().chrome;
const bg = require(path.join('..', 'background.js'));

// Install a fresh mock store and return its harness.
function freshStore(opts) {
  const harness = createMockChrome(opts);
  global.chrome = harness.chrome;
  return harness;
}

function clipPayload(text, host) {
  return {
    text: text,
    source: 'https://' + (host || 'example.com') + '/page',
    hostname: host || 'example.com',
    pageTitle: 'Title',
    scrollY: 0
  };
}

test('addClip stores a new clip and updates stats', async () => {
  const h = freshStore();
  const res = await bg.addClip(clipPayload('hello world', 'github.com'));
  assert.equal(res.success, true);
  assert.equal(h.store.memclip_history.length, 1);
  assert.equal(h.store.memclip_history[0].text, 'hello world');
  assert.equal(h.store.memclip_stats.totalCopies, 1);
  assert.equal(h.store.memclip_stats.topDomains['github.com'], 1);
});

test('addClip de-duplicates by text and bumps copyCount', async () => {
  const h = freshStore();
  await bg.addClip(clipPayload('same', 'a.com'));
  await bg.addClip(clipPayload('same', 'b.com'));
  assert.equal(h.store.memclip_history.length, 1);
  assert.equal(h.store.memclip_history[0].copyCount, 2);
  // Most recent source wins.
  assert.equal(h.store.memclip_history[0].hostname, 'b.com');
  assert.equal(h.store.memclip_stats.totalCopies, 2);
});

test('serialized queue: 50 concurrent copies all land (no lost writes)', async () => {
  const h = freshStore();
  const jobs = [];
  for (let i = 0; i < 50; i++) {
    jobs.push(bg.addClip(clipPayload('clip-' + i, 'site.com')));
  }
  await Promise.all(jobs);
  assert.equal(h.store.memclip_history.length, 50);
  assert.equal(h.store.memclip_stats.totalCopies, 50);
});

test('pinned clips sort to the top', async () => {
  const h = freshStore();
  await bg.addClip(clipPayload('first'));
  await bg.addClip(clipPayload('second'));
  const id = h.store.memclip_history.find(c => c.text === 'first').id;
  await bg.pinClip(id);
  assert.equal(h.store.memclip_history[0].text, 'first');
  assert.equal(h.store.memclip_history[0].pinned, true);
});

test('recordPaste matches existing clip and increments pasteCount', async () => {
  const h = freshStore();
  await bg.addClip(clipPayload('paste me', 'src.com'));
  const res = await bg.recordPaste({
    text: 'paste me', destUrl: 'https://dest.com/x', destHostname: 'dest.com', destTitle: 'Dest'
  });
  assert.equal(res.success, true);
  const clip = h.store.memclip_history[0];
  assert.equal(clip.pasteCount, 1);
  assert.equal(clip.pastedTo[0].hostname, 'dest.com');
  assert.equal(h.store.memclip_stats.totalPastes, 1);
});

test('recordPaste of unknown text creates an externalOrigin clip', async () => {
  const h = freshStore();
  await bg.recordPaste({
    text: 'from another app', destUrl: 'https://dest.com/x', destHostname: 'dest.com', destTitle: 'Dest'
  });
  assert.equal(h.store.memclip_history.length, 1);
  assert.equal(h.store.memclip_history[0].externalOrigin, true);
  assert.equal(h.store.memclip_history[0].pasteCount, 1);
});

test('deleteClip removes by id', async () => {
  const h = freshStore();
  await bg.addClip(clipPayload('keep'));
  await bg.addClip(clipPayload('remove'));
  const id = h.store.memclip_history.find(c => c.text === 'remove').id;
  const res = await bg.deleteClip(id);
  assert.equal(res.removed, 1);
  assert.equal(h.store.memclip_history.length, 1);
  assert.equal(h.store.memclip_history[0].text, 'keep');
});

test('clearAll keeps pinned clips and rebuilds stats', async () => {
  const h = freshStore();
  await bg.addClip(clipPayload('temp', 'temp.com'));
  await bg.addClip(clipPayload('keep', 'keep.com'));
  const id = h.store.memclip_history.find(c => c.text === 'keep').id;
  await bg.pinClip(id);
  const res = await bg.clearAll();
  assert.equal(res.kept, 1);
  assert.equal(h.store.memclip_history.length, 1);
  assert.equal(h.store.memclip_history[0].text, 'keep');
  // Stats no longer reference the removed domain.
  assert.equal(h.store.memclip_stats.topDomains['temp.com'], undefined);
  assert.equal(h.store.memclip_stats.topDomains['keep.com'], 1);
});

test('capText truncates clips larger than the byte cap', () => {
  const big = 'x'.repeat(bg._constants.MAX_CLIP_BYTES + 5000);
  const capped = bg.capText(big);
  assert.equal(capped.truncated, true);
  assert.ok(Buffer.byteLength(capped.text) <= bg._constants.MAX_CLIP_BYTES);
});

test('quota pressure: writes succeed by shedding oldest unpinned clips', async () => {
  // Tight quota so only a handful of ~1KB clips fit at once.
  const h = freshStore({ quotaBytes: 6000 });
  let lastRes;
  for (let i = 0; i < 40; i++) {
    lastRes = await bg.addClip(clipPayload('z'.repeat(1000) + i, 'q.com'));
  }
  assert.equal(lastRes.success, true, 'final write should succeed after shedding');
  assert.ok(h.size() <= 6000, 'store stays within quota, got ' + h.size());
  assert.ok(h.store.memclip_history.length < 40, 'older clips were shed');
  // The most recent clip must survive.
  assert.ok(h.store.memclip_history.some(c => c.text.endsWith('39')));
});

test('quota pressure: pinned clips are never shed', async () => {
  const h = freshStore({ quotaBytes: 8000 });
  await bg.addClip(clipPayload('p'.repeat(800) + 'PINNED', 'pin.com'));
  const id = h.store.memclip_history[0].id;
  await bg.pinClip(id);
  for (let i = 0; i < 40; i++) {
    await bg.addClip(clipPayload('u'.repeat(800) + i, 'u.com'));
  }
  assert.ok(
    h.store.memclip_history.some(c => c.text.endsWith('PINNED')),
    'pinned clip should survive quota shedding'
  );
});

// --- Phase 3: bulk delete + pinned reorder ---

test('deleteClips removes multiple clips by id in one shot', async () => {
  const h = freshStore();
  await bg.addClip(clipPayload('a'));
  await bg.addClip(clipPayload('b'));
  await bg.addClip(clipPayload('c'));
  const ids = h.store.memclip_history
    .filter(c => c.text === 'a' || c.text === 'c')
    .map(c => c.id);
  const res = await bg.deleteClips(ids);
  assert.equal(res.removed, 2);
  assert.equal(h.store.memclip_history.length, 1);
  assert.equal(h.store.memclip_history[0].text, 'b');
});

test('reorderPinned stamps pinRank so pinned clips honor manual order', async () => {
  const h = freshStore();
  await bg.addClip(clipPayload('one'));
  await bg.addClip(clipPayload('two'));
  await bg.addClip(clipPayload('three'));
  const byText = {};
  h.store.memclip_history.forEach(c => { byText[c.text] = c.id; });
  // Pin all three.
  await bg.pinClip(byText.one);
  await bg.pinClip(byText.two);
  await bg.pinClip(byText.three);

  // Desired order: three, one, two.
  const order = [byText.three, byText.one, byText.two];
  const res = await bg.reorderPinned(order);
  assert.equal(res.ordered, 3);

  // sortHistory should now place them in the manual order.
  const sorted = bg.sortHistory(h.store.memclip_history.slice());
  assert.deepEqual(sorted.map(c => c.text), ['three', 'one', 'two']);
});

test('reorderPinned order survives a subsequent save/sort', async () => {
  const h = freshStore();
  await bg.addClip(clipPayload('x'));
  await bg.addClip(clipPayload('y'));
  const ids = { x: null, y: null };
  h.store.memclip_history.forEach(c => { ids[c.text] = c.id; });
  await bg.pinClip(ids.x);
  await bg.pinClip(ids.y);
  await bg.reorderPinned([ids.y, ids.x]);
  // Re-pin toggle off/on of an unrelated add shouldn't disturb ranks.
  await bg.addClip(clipPayload('z'));
  const sorted = bg.sortHistory(h.store.memclip_history.slice());
  const pinnedTexts = sorted.filter(c => c.pinned).map(c => c.text);
  assert.deepEqual(pinnedTexts, ['y', 'x']);
});

// --- Phase 5: export/import (backup) ---

test('importData (merge) adds new clips and dedupes by text', async () => {
  const h = freshStore();
  await bg.addClip(clipPayload('keep me', 'a.com'));
  const res = await bg.importData({
    clips: [
      { text: 'keep me', copyCount: 5 },   // dupe -> merge (higher count wins)
      { text: 'brand new', hostname: 'b.com' }
    ]
  }, 'merge');
  assert.equal(res.added, 1);
  assert.equal(res.total, 2);
  const byText = {};
  h.store.memclip_history.forEach(c => { byText[c.text] = c; });
  assert.ok(byText['brand new'], 'new clip imported');
  assert.equal(byText['keep me'].copyCount, 5, 'higher copyCount merged in');
});

test('importData (merge) ORs the pinned flag onto an existing clip', async () => {
  const h = freshStore();
  await bg.addClip(clipPayload('star', 'a.com'));
  await bg.importData({ clips: [{ text: 'star', pinned: true }] }, 'merge');
  const clip = h.store.memclip_history.find(c => c.text === 'star');
  assert.equal(clip.pinned, true);
});

test('importData (replace) swaps history and restores settings', async () => {
  const h = freshStore();
  await bg.addClip(clipPayload('old one', 'a.com'));
  const res = await bg.importData({
    clips: [{ text: 'fresh', hostname: 'z.com', copyCount: 2 }],
    settings: { ignoreSensitive: false, denylist: ['blocked.com'] }
  }, 'replace');
  assert.equal(res.total, 1);
  assert.equal(h.store.memclip_history.length, 1);
  assert.equal(h.store.memclip_history[0].text, 'fresh');
  assert.deepEqual(h.store.memclip_settings.denylist, ['blocked.com']);
  // Stats are rebuilt from the imported clips, never trusted from the file.
  assert.equal(h.store.memclip_stats.totalCopies, 2);
});

test('importData drops malformed records and guarantees unique ids', async () => {
  const h = freshStore();
  const res = await bg.importData({
    clips: [
      { text: 'good' },
      { text: '' },          // empty -> dropped
      null,                  // junk -> dropped
      { id: 'dup', text: 'one' },
      { id: 'dup', text: 'two' }  // id collision -> reassigned
    ]
  }, 'replace');
  assert.equal(res.total, 3);
  const ids = h.store.memclip_history.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length, 'all ids unique');
});

test('importData accepts a bare array of clips', async () => {
  const h = freshStore();
  const res = await bg.importData([{ text: 'a' }, { text: 'b' }], 'replace');
  assert.equal(res.total, 2);
  assert.equal(h.store.memclip_history.length, 2);
});
