// End-to-end-ish integration test.
// Runs the real content.js (capture) and the real popup.html + popup.js
// (render) against ONE shared chrome.storage mock, then asserts a clip element
// actually appears in the popup DOM. This mirrors what the user does in Opera.
//
// Run with:  node --test test/integration.test.js

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

// ---- one shared storage + onChanged dispatcher ----
function makeSharedChrome() {
  const store = {};
  const changeListeners = [];

  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }

  const runtime = {
    lastError: null,
    id: 'test-extension-id',
    onMessage: { addListener: function () {} },
    sendMessage: function (msg, cb) {
      // Popup may call GET_STATS etc.; return benign responses.
      if (typeof cb === 'function') setTimeout(() => cb({ success: true, logs: [], clips: [] }), 0);
    }
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
        runtime.lastError = null;
        const changes = {};
        Object.keys(obj).forEach((k) => {
          changes[k] = { oldValue: clone(store[k]), newValue: clone(obj[k]) };
          store[k] = clone(obj[k]);
        });
        if (cb) cb();
        // notify listeners (mimics chrome.storage.onChanged across contexts)
        changeListeners.forEach((fn) => {
          try { fn(changes, 'local'); } catch (e) {}
        });
      }, 1);
    },
    getBytesInUse: function (keys, cb) {
      setTimeout(() => cb(Buffer.byteLength(JSON.stringify(store))), 1);
    }
  };

  const chrome = {
    runtime: runtime,
    storage: {
      local: local,
      onChanged: { addListener: function (fn) { changeListeners.push(fn); } }
    }
  };

  return { chrome, store };
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

  const dom = loadPopup(chrome);
  const list = dom.window.document.getElementById('clips-list');

  const ok = await until(() => list && /hello from storage/.test(list.textContent), 3000);
  assert.ok(ok, 'clip should render under All. Got: ' + (list ? list.textContent : '(no list)'));
});

test('content.js copy is captured and shows live in an open popup', async () => {
  const shared = makeSharedChrome();
  const dom = loadPopup(shared.chrome);
  const list = dom.window.document.getElementById('clips-list');

  // popup starts empty
  await until(() => list && list.textContent.length >= 0, 1000);

  // user copies on a page
  runContentCopy(shared.chrome, 'captured live text', 'https://example.com/page');

  const ok = await until(() => list && /captured live text/.test(list.textContent), 4000);
  assert.ok(ok, 'copied clip should appear live via storage.onChanged. List: ' + (list ? list.textContent : '(none)'));
  // storage actually has it
  assert.ok(shared.store.memclip_history && shared.store.memclip_history.length === 1);
  assert.equal(shared.store.memclip_history[0].text, 'captured live text');
});

test('content.js paste updates an existing clip and shows live (used 1x)', async () => {
  const shared = makeSharedChrome();
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

// Phase 1: content.js must survive a full storage quota by shedding the oldest
// unpinned clips and retrying, while never dropping pinned clips.
test('content.js sheds oldest unpinned clips on quota failure, preserves pinned', async () => {
  const big = (label) => label + ' ' + 'A'.repeat(1500);
  const store = {};
  const pinned = { id: 'pin', text: big('PINNED'), pinned: true, copyCount: 1, pasteCount: 0, pastedTo: [] };
  const unpinned = [];
  for (let i = 0; i < 8; i++) {
    unpinned.push({ id: 'u' + i, text: big('OLD' + i), pinned: false, copyCount: 1, pasteCount: 0, pastedTo: [], timestamp: i });
  }
  // newest-first: u7..u0 then pinned (oldest)
  store.memclip_history = unpinned.slice().reverse().concat([pinned]);
  store.memclip_stats = { totalCopies: 8, totalPastes: 0, topDomains: {}, topPasteDestinations: {} };

  // Quota that only fits pinned + 3 big clips -> forces shedding when a 9th arrives.
  const QUOTA = Buffer.byteLength(JSON.stringify({
    memclip_history: [pinned, unpinned[0], unpinned[1], unpinned[2]],
    memclip_stats: store.memclip_stats
  })) + 1200;

  function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
  const chrome = {
    runtime: { lastError: null, id: 'q', onMessage: { addListener() {} }, sendMessage() {} },
    storage: {
      onChanged: { addListener() {} },
      local: {
        get(keys, cb) {
          setTimeout(() => {
            chrome.runtime.lastError = null;
            const out = {};
            (Array.isArray(keys) ? keys : [keys]).forEach((k) => { if (store[k] !== undefined) out[k] = clone(store[k]); });
            cb(out);
          }, 1);
        },
        set(obj, cb) {
          setTimeout(() => {
            const prospective = Object.assign({}, store);
            Object.keys(obj).forEach((k) => { prospective[k] = obj[k]; });
            if (Buffer.byteLength(JSON.stringify(prospective)) > QUOTA) {
              chrome.runtime.lastError = { message: 'QUOTA_BYTES quota exceeded' };
              cb();
            } else {
              chrome.runtime.lastError = null;
              Object.keys(obj).forEach((k) => { store[k] = clone(obj[k]); });
              cb();
            }
          }, 1);
        }
      }
    }
  };

  const handlers = {};
  const lightDoc = {
    title: 'T', addEventListener: (t, f) => { handlers[t] = f; }, getElementById: () => null,
    getSelection: () => ({ toString: () => 'BRAND NEW CLIP' }), get activeElement() { return null; },
    createElement: () => ({ style: {}, remove() {}, set textContent(v) {} }), body: { appendChild() {} }
  };
  const lightWin = {
    __memclip_loaded: false, location: { href: 'https://q.com/a', hostname: 'q.com' },
    scrollY: 0, getSelection: () => ({ toString: () => 'BRAND NEW CLIP' }), addEventListener: () => {}, scrollTo: () => {}
  };
  const vm = require('node:vm');
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'content.js'), 'utf8'), {
    window: lightWin, document: lightDoc, chrome,
    navigator: { clipboard: { readText: () => Promise.resolve('') } },
    console: console, setTimeout, Date, Math, URL
  });
  handlers['copy']({ clipboardData: { getData: () => '' } });

  // Wait for the new clip to be written (i.e. shedding+retry succeeded).
  const saved = await until(
    () => store.memclip_history.some((c) => c.text === 'BRAND NEW CLIP'),
    4000
  );
  assert.ok(saved, 'new clip should be saved after shedding old unpinned clips');
  assert.ok(store.memclip_history.some((c) => c.id === 'pin'), 'pinned clip must never be shed');
  assert.ok(store.memclip_history.length < 9, 'history should have shed some old unpinned clips');
  assert.ok(
    Buffer.byteLength(JSON.stringify({ memclip_history: store.memclip_history, memclip_stats: store.memclip_stats })) <= QUOTA,
    'final stored state should fit within quota'
  );
});

// Phase 2: privacy/security gating in content.js.
test('content.js skips sensitive data (credit-card number) by default', async () => {
  const { chrome, store } = makeSharedChrome();
  const h = mountContent(chrome, { selection: '4111 1111 1111 1111', href: 'https://allowed.com/x' });
  await wait(30);
  h.copy({ clipboardData: { getData: () => '' } });
  await wait(60);
  assert.ok(!store.memclip_history || store.memclip_history.length === 0, 'credit card should not be stored');
});

test('content.js skips copies made inside password fields', async () => {
  const { chrome, store } = makeSharedChrome();
  const h = mountContent(chrome, {
    selection: 'hunter2secretpw',
    activeElement: { tagName: 'INPUT', type: 'password' },
    href: 'https://allowed.com/x'
  });
  await wait(30);
  h.copy({ clipboardData: { getData: () => '' } });
  await wait(60);
  assert.ok(!store.memclip_history || store.memclip_history.length === 0, 'password-field copy should not be stored');
});

test('content.js respects the per-site denylist (incl. subdomains)', async () => {
  const { chrome, store } = makeSharedChrome();
  store.memclip_settings = { ignoreSensitive: true, skipPasswordFields: true, captureIncognito: false, denylist: ['blocked.com'] };
  const h = mountContent(chrome, { selection: 'totally normal text', href: 'https://sub.blocked.com/x' });
  await wait(45);
  h.copy({ clipboardData: { getData: () => '' } });
  await wait(60);
  assert.ok(!store.memclip_history || store.memclip_history.length === 0, 'denylisted site must not capture');
});

test('content.js still captures normal text on allowed sites', async () => {
  const { chrome, store } = makeSharedChrome();
  const h = mountContent(chrome, { selection: 'just some normal copied text', href: 'https://allowed.com/x' });
  await wait(30);
  h.copy({ clipboardData: { getData: () => '' } });
  await wait(60);
  assert.ok(store.memclip_history && store.memclip_history.length === 1, 'normal text should be captured');
  assert.equal(store.memclip_history[0].text, 'just some normal copied text');
});
