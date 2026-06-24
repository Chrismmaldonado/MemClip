// Minimal, configurable mock of the Chrome extension APIs that background.js
// uses. Storage is intentionally ASYNCHRONOUS (with a tiny random delay) so the
// serialized write queue is genuinely exercised — a naive read-modify-write
// would interleave and lose data under this mock.

function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

function byteSize(obj) {
  return Buffer.byteLength(JSON.stringify(obj));
}

function createMockChrome(options) {
  options = options || {};
  var store = options.store || {};
  var quotaBytes = typeof options.quotaBytes === 'number' ? options.quotaBytes : Infinity;
  var maxDelay = typeof options.maxDelay === 'number' ? options.maxDelay : 4;

  function defer(fn) {
    setTimeout(fn, Math.floor(Math.random() * maxDelay));
  }

  var runtime = {
    lastError: null,
    onMessage: { addListener: function() {} },
    onInstalled: { addListener: function() {} },
    onStartup: { addListener: function() {} },
    getURL: function(p) { return 'chrome-extension://test/' + p; },
    sendMessage: function() {}
  };

  var chrome = {
    runtime: runtime,
    storage: {
      local: {
        get: function(keys, cb) {
          defer(function() {
            runtime.lastError = null;
            var out = {};
            var list = Array.isArray(keys) ? keys : [keys];
            list.forEach(function(k) {
              if (store[k] !== undefined) out[k] = clone(store[k]);
            });
            cb(out);
          });
        },
        set: function(obj, cb) {
          defer(function() {
            var merged = Object.assign({}, store, obj);
            if (byteSize(merged) > quotaBytes) {
              runtime.lastError = { message: 'QUOTA_BYTES quota exceeded' };
              cb();
              runtime.lastError = null;
              return;
            }
            Object.keys(obj).forEach(function(k) { store[k] = clone(obj[k]); });
            runtime.lastError = null;
            cb();
          });
        }
      }
    },
    tabs: {
      create: function(o, cb) { cb({ id: 1 }); },
      onUpdated: { addListener: function() {}, removeListener: function() {} },
      sendMessage: function() {}
    },
    windows: {
      create: function(o, cb) { cb({ id: 1 }); },
      update: function(id, o, cb) { if (cb) cb(); },
      onRemoved: { addListener: function() {} }
    },
    action: { onClicked: { addListener: function() {} } },
    commands: { onCommand: { addListener: function() {} } }
  };

  return {
    chrome: chrome,
    store: store,
    setQuota: function(n) { quotaBytes = n; },
    size: function() { return byteSize(store); }
  };
}

module.exports = { createMockChrome: createMockChrome, byteSize: byteSize };
