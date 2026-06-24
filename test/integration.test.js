// End-to-end-ish integration test.
// Runs the real content.js (capture) + the real background.js (the single
// storage writer) + the real popup.html/popup.js (render) against ONE shared
// chrome mock, then asserts a clip element actually appears in the popup DOM.
// This mirrors what the user does in the browser: content captures, messages
// the background, the background commits through its serialized queue, and the
// popup updates live via chrome.storage.onChanged.
//
// Run with:  node --test test/integration.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const BG_PATH = require.resolve(path.join(ROOT, 'background.js'));

// Load (or reload) the real background service worker against a given chrome
// mock. background.js wires its message router + listeners at load time and its
// functions read the *global* chrome at call time, so a fresh require bound to
// `global.chrome` gives each test an isolated background + storage.
function loadBackgroundFresh(chrome) {
  global.chrome = chrome;
  delete require.cache[BG_PATH];
  require(BG_PATH);
}

function byteOf(obj) { return Buffer.byteLength(JSON.stringify(obj)); }

// ---- one shared storage + onChanged dispatcher + message router bus ----
function makeSharedChrome(options) {
  options = options || {};
  const store = {};
  const changeListeners = [];
  const msgListeners = [];
  const quotaBytes = typeof options.quotaBytes === 'number' ? options.quotaBytes : Infinity;

  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  function dispatchMessage(msg, sender, cb) {
    let responded = false;
    function sendResponse(resp) {
      if (responded) return;
      responded = true;
      if (typeof cb === 'function') setTimeout(() => cb(resp), 0);
    }
    if (msgListeners.length) {
      msgListeners.forEach((fn) => { try { fn(msg, sender, sendResponse); } catch (e) {} });
    } else if (typeof cb === 'function') {
      // No background mounted: benign reply so popup-only reads don't hang.
      setTimeout(() => cb({ success: true, logs: [], clips: [] }), 0);
    }
  }

  const runtime = {
    lastError: null,
    id: 'test-extension-id',
    getURL: function (p) { return 'chrome-extension://test/' + p; },
    onMessage: { addListener: function (fn) { msgListeners.push(fn); } },
    onInstalled: { addListener: function () {} },
    onStartup: { addListener: function () {} },
    sendMessage: function (msg, cb) { dispatchMessage(msg, { id: 'test-extension-id' }, cb); }
  };

  const local = {
    get: function (keys, cb) {
      setTimeout(() => {
        runtime.lastError = null;
        const out = {};
        const list = Array.isArray(keys) ? keys : (keys === null ? Object.keys(store) : [keys]);
        list.forEach((k) => { if (store[k] !== undefined) out[k] = clone(store[k]); });
        cb(out);
      }, 1);
    },
    set: function (obj, cb) {
      setTimeout(() => {
        const merged = Object.assign({}, store, obj);
        if (byteOf(merged) > quotaBytes) {
          runtime.lastError = { message: 'QUOTA_BYTES quota exceeded' };
          if (cb) cb();
          runtime.lastError = null;
          return;
        }
        runtime.lastError = null;
        const changes = {};
        Object.keys(obj).forEach((k) => {
          changes[k] = { oldValue: clone(store[k]), newValue: clone(obj[k]) };
          store[k] = clone(obj[k]);
        });
        if (cb) cb();
        changeListeners.forEach((fn) => { try { fn(changes, 'local'); } catch (e) {} });
      }, 1);
    },
    getBytesInUse: function (keys, cb) {
      setTimeout(() => cb(byteOf(store)), 1);
    }
  };

  const chrome = {
    runtime: runtime,
    storage: {
      local: local,
      onChanged: { addListener: function (fn) { changeListeners.push(fn); } }
    },
    tabs: {
      create: function (o, cb) { if (cb) cb({ id: 1 }); },
      query: function (q, cb) { if (cb) cb([]); },
      onUpdated: { addListener: function () {}, removeListener: function () {} },
      sendMessage: function () {}
    },
    windows: {
      create: function (o, cb) { if (cb) cb({ id: 1 }); },
      update: function (id, o, cb) { if (cb) cb(); },
      get: function (id, cb) { if (cb) cb({ id: id }); },
      onRemoved: { addListener: function () {} }
    },
    action: { onClicked: { addListener: function () {} } },
    commands: { onCommand: { addListener: function () {} } }
  };

  return {
    chrome: chrome,
    store: store,
    // Fire a message into the router with an explicit sender (e.g. an incognito
    // tab) and resolve with the router's response.
    emitMessage: function (msg, sender) {
      return new Promise((resolve) => dispatchMessage(msg, sender || { id: 'test-extension-id' }, resolve));
    }
  };
}

function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Mount content.js against a shared chrome with a configurable DOM, returning
// the captured event handlers so a test can fire copy/paste explicitly.
function mountContent(sharedChrome, opts) {
  opts = opts || {};
  const handlers = {};
  const sel = opts.selection || '';
  const activeEl = opts.activeElement || null;
  const href = opts.href || 'https://allowed.com/p';
  const loc = new URL(href);
  const lightDoc = {
    title: opts.title || 'Page',
    addEventListener: (t, f) => { handlers[t] = f; },
    getElementById: () => null,
    getSelection: () => ({ toString: () => sel }),
    get activeElement() { return activeEl; },
    createElement: () => ({ style: {}, remove() {}, set textContent(v) {} }),
    body: { appendChild() {} }
  };
  const lightWin = {
    __memclip_loaded: false,
    location: { href: href, hostname: loc.hostname },
    scrollY: 0,
    getSelection: () => ({ toString: () => sel }),
    addEventListener: () => {}, scrollTo: () => {}
  };
  const vm = require('node:vm');
  vm.runInNewContext(require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'content.js'), 'utf8'), {
    window: lightWin, document: lightDoc, chrome: sharedChrome,
    navigator: { clipboard: { readText: () => Promise.resolve('') } },
    console: console, setTimeout, Date, Math, URL
  });
  return handlers;
}

async function until(predicate, timeoutMs) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    await wait(15);
  }
  return false;
}

// Run content.js against a light DOM that shares the given chrome mock, then
// fire a synthetic copy of `selectionText`.
function runContentCopy(sharedChrome, selectionText, href) {
  const handlers = {};
  const loc = new URL(href);
  const lightDoc = {
    title: 'Test Page',
    addEventListener: (t, f) => { handlers[t] = f; },
    getElementById: () => null,
    getSelection: () => ({ toString: () => selectionText }),
    get activeElement() { return null; },
    createElement: () => ({ style: {}, remove() {}, set textContent(v) {} }),
    body: { appendChild() {} }
  };
  const lightWin = {
    __memclip_loaded: false,
    location: { href: href, hostname: loc.hostname },
    scrollY: 0,
    getSelection: () => ({ toString: () => selectionText }),
    addEventListener: () => {},
    scrollTo: () => {}
  };

  const sandbox = {
    window: lightWin, document: lightDoc, chrome: sharedChrome,
    navigator: { clipboard: { readText: () => Promise.resolve('') } },
    console: console, setTimeout: setTimeout, Date: Date, Math: Math, URL: URL
  };

  const code = fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8');
  const vm = require('node:vm');
  vm.runInNewContext(code, sandbox);

  // Fire a copy event (clipboardData empty, like a real copy event).
  handlers['copy']({ clipboardData: { getData: () => '' } });
}

function loadPopup(sharedChrome) {
  const html = fs.readFileSync(path.join(ROOT, 'popup.html'), 'utf8');
  const { VirtualConsole } = require('jsdom');
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => console.error('[jsdom error]', e && (e.detail || e.message || e)));
  const dom = new JSDOM(html, { runScripts: 'dangerously', pretendToBeVisual: true, virtualConsole: vc });
  const { window } = dom;

  window.chrome = sharedChrome;
  window.confirm = () => true;
  window.addEventListener('error', (ev) => console.error('[popup error]', ev.error && ev.error.stack || ev.message));
  if (!window.navigator.clipboard) {
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText: () => Promise.resolve() }, configurable: true
    });
  }

  // Execute popup.js inside the window (dangerously runs injected scripts),
  // then fire DOMContentLoaded so its listener runs.
  const popupSrc = fs.readFileSync(path.join(ROOT, 'popup.js'), 'utf8');
  const scriptEl = window.document.createElement('script');
  scriptEl.textContent = popupSrc;
  window.document.body.appendChild(scriptEl);
  window.document.dispatchEvent(new window.Event('DOMContentLoaded'));

  return dom;
}

test('popup renders a clip that already exists in storage', async () => {
  const { chrome, store } = makeSharedChrome();
  store.memclip_history = [{
    id: 'x1', text: 'hello from storage', hostname: 'github.com',
    source: 'https://github.com/x', pageTitle: 'GH', timestamp: Date.now(),
    type: 'text', pinned: false, copyCount: 1, pasteCount: 0, pastedTo: []
  }];
  loadBackgroundFresh(chrome);

  const dom = loadPopup(chrome);
  const list = dom.window.document.getElementById('clips-list');

  const ok = await until(() => list && /hello from storage/.test(list.textContent), 3000);
  assert.ok(ok, 'clip should render under All. Got: ' + (list ? list.textContent : '(no list)'));
});

test('content.js copy routes through the background and shows live in an open popup', async () => {
  const shared = makeSharedChrome();
  loadBackgroundFresh(shared.chrome);
  const dom = loadPopup(shared.chrome);
  const list = dom.window.document.getElementById('clips-list');

  // popup starts empty
  await until(() => list && list.textContent.length >= 0, 1000);

  // user copies on a page
  runContentCopy(shared.chrome, 'captured live text', 'https://example.com/page');

  const ok = await until(() => list && /captured live text/.test(list.textContent), 4000);
  assert.ok(ok, 'copied clip should appear live via storage.onChanged. List: ' + (list ? list.textContent : '(none)'));
  // background actually committed it
  assert.ok(shared.store.memclip_history && shared.store.memclip_history.length === 1);
  assert.equal(shared.store.memclip_history[0].text, 'captured live text');
});

test('content.js paste routes through the background and shows live (used 1x)', async () => {
  const shared = makeSharedChrome();
  loadBackgroundFresh(shared.chrome);
  const dom = loadPopup(shared.chrome);
  const list = dom.window.document.getElementById('clips-list');

  runContentCopy(shared.chrome, 'paste target text', 'https://src.com/a');
  await until(() => list && /paste target text/.test(list.textContent), 4000);

  // Simulate a paste of the same text on another site by running content.js
  // paste handler. Reuse the capture harness but trigger paste.
  const handlers = {};
  const lightDoc = {
    title: 'Dest', addEventListener: (t, f) => { handlers[t] = f; }, getElementById: () => null,
    getSelection: () => ({ toString: () => '' }), get activeElement() { return null; },
    createElement: () => ({ style: {}, remove() {}, set textContent(v) {} }), body: { appendChild() {} }
  };
  const lightWin = {
    __memclip_loaded: false, location: { href: 'https://dest.com/x', hostname: 'dest.com' },
    scrollY: 0, getSelection: () => ({ toString: () => '' }), addEventListener: () => {}, scrollTo: () => {}
  };
  const vm = require('node:vm');
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8'), {
    window: lightWin, document: lightDoc, chrome: shared.chrome,
    navigator: { clipboard: { readText: () => Promise.resolve('') } },
    console: console, setTimeout: setTimeout, Date: Date, Math: Math, URL: URL
  });
  handlers['paste']({ clipboardData: { getData: () => 'paste target text' } });

  const ok = await until(() => list && /used 1x/.test(list.textContent), 4000);
  assert.ok(ok, 'paste should bump pasteCount and show "used 1x" live. List: ' + (list ? list.textContent : '(none)'));
});

// The background (single writer) must survive a full storage quota by shedding
// the oldest unpinned clips and retrying, while never dropping pinned clips —
// exercised here through the real content -> message -> background path.
test('a copy under quota pressure sheds oldest unpinned clips, preserves pinned', async () => {
  const big = (label) => label + ' ' + 'A'.repeat(1500);
  const pinned = { id: 'pin', text: big('PINNED'), pinned: true, copyCount: 1, pasteCount: 0, pastedTo: [], timestamp: -1 };
  const unpinned = [];
  for (let i = 0; i < 8; i++) {
    unpinned.push({ id: 'u' + i, text: big('OLD' + i), pinned: false, copyCount: 1, pasteCount: 0, pastedTo: [], timestamp: i });
  }

  // Quota that only fits pinned + ~3 big clips -> forces shedding when a 9th arrives.
  const stats = { totalCopies: 8, totalPastes: 0, topDomains: {}, topPasteDestinations: {} };
  const QUOTA = byteOf({
    memclip_history: [pinned, unpinned[0], unpinned[1], unpinned[2]],
    memclip_stats: stats
  }) + 1200;

  const shared = makeSharedChrome({ quotaBytes: QUOTA });
  // newest-first: u7..u0 then pinned (oldest)
  shared.store.memclip_history = unpinned.slice().reverse().concat([pinned]);
  shared.store.memclip_stats = stats;
  loadBackgroundFresh(shared.chrome);

  const handlers = mountContent(shared.chrome, { selection: 'BRAND NEW CLIP', href: 'https://q.com/a' });
  await wait(20);
  handlers['copy']({ clipboardData: { getData: () => '' } });

  const saved = await until(
    () => shared.store.memclip_history.some((c) => c.text === 'BRAND NEW CLIP'),
    4000
  );
  assert.ok(saved, 'new clip should be saved after shedding old unpinned clips');
  assert.ok(shared.store.memclip_history.some((c) => c.id === 'pin'), 'pinned clip must never be shed');
  assert.ok(shared.store.memclip_history.length < 9, 'history should have shed some old unpinned clips');
  assert.ok(
    byteOf({ memclip_history: shared.store.memclip_history, memclip_stats: shared.store.memclip_stats }) <= QUOTA,
    'final stored state should fit within quota'
  );
});

// Privacy/security gating in content.js (the gate runs before any message is
// sent, so blocked content never reaches the background).
test('content.js skips sensitive data (credit-card number) by default', async () => {
  const shared = makeSharedChrome();
  loadBackgroundFresh(shared.chrome);
  const h = mountContent(shared.chrome, { selection: '4111 1111 1111 1111', href: 'https://allowed.com/x' });
  await wait(30);
  h.copy({ clipboardData: { getData: () => '' } });
  await wait(80);
  assert.ok(!shared.store.memclip_history || shared.store.memclip_history.length === 0, 'credit card should not be stored');
});

test('content.js skips copies made inside password fields', async () => {
  const shared = makeSharedChrome();
  loadBackgroundFresh(shared.chrome);
  const h = mountContent(shared.chrome, {
    selection: 'hunter2secretpw',
    activeElement: { tagName: 'INPUT', type: 'password' },
    href: 'https://allowed.com/x'
  });
  await wait(30);
  h.copy({ clipboardData: { getData: () => '' } });
  await wait(80);
  assert.ok(!shared.store.memclip_history || shared.store.memclip_history.length === 0, 'password-field copy should not be stored');
});

test('content.js respects the per-site denylist (incl. subdomains)', async () => {
  const shared = makeSharedChrome();
  shared.store.memclip_settings = { ignoreSensitive: true, skipPasswordFields: true, captureIncognito: false, denylist: ['blocked.com'] };
  loadBackgroundFresh(shared.chrome);
  const h = mountContent(shared.chrome, { selection: 'totally normal text', href: 'https://sub.blocked.com/x' });
  await wait(45);
  h.copy({ clipboardData: { getData: () => '' } });
  await wait(80);
  assert.ok(!shared.store.memclip_history || shared.store.memclip_history.length === 0, 'denylisted site must not capture');
});

test('content.js still captures normal text on allowed sites', async () => {
  const shared = makeSharedChrome();
  loadBackgroundFresh(shared.chrome);
  const h = mountContent(shared.chrome, { selection: 'just some normal copied text', href: 'https://allowed.com/x' });
  await wait(30);
  h.copy({ clipboardData: { getData: () => '' } });
  const ok = await until(() => shared.store.memclip_history && shared.store.memclip_history.length === 1, 3000);
  assert.ok(ok, 'normal text should be captured');
  assert.equal(shared.store.memclip_history[0].text, 'just some normal copied text');
});

// The background is the authoritative incognito gate: even if the content
// script's own detection fails open, an ADD_CLIP from an incognito tab must be
// dropped unless the user explicitly opted in.
test('background drops captures from an incognito tab by default', async () => {
  const shared = makeSharedChrome();
  loadBackgroundFresh(shared.chrome);
  const res = await shared.emitMessage(
    { type: 'ADD_CLIP', payload: { text: 'secret incognito copy', source: 'https://x.com/a', hostname: 'x.com', pageTitle: 'X' } },
    { id: 'test-extension-id', tab: { incognito: true } }
  );
  assert.equal(res.success, false);
  assert.equal(res.skipped, 'incognito');
  await wait(40);
  assert.ok(!shared.store.memclip_history || shared.store.memclip_history.length === 0, 'incognito copy must not be stored');
});

test('background captures from an incognito tab when the user opts in', async () => {
  const shared = makeSharedChrome();
  shared.store.memclip_settings = { captureIncognito: true };
  loadBackgroundFresh(shared.chrome);
  const res = await shared.emitMessage(
    { type: 'ADD_CLIP', payload: { text: 'allowed incognito copy', source: 'https://x.com/a', hostname: 'x.com', pageTitle: 'X' } },
    { id: 'test-extension-id', tab: { incognito: true } }
  );
  assert.equal(res.success, true);
  await until(() => shared.store.memclip_history && shared.store.memclip_history.length === 1, 2000);
  assert.equal(shared.store.memclip_history[0].text, 'allowed incognito copy');
});
