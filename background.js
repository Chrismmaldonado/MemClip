// MemClip Background Service Worker
// Single source of truth for all storage WRITES. The content script and popup
// send messages; every mutation runs through a serialized queue here so that
// concurrent copies (multiple tabs), popup actions, and the scheduled purge
// can never clobber each other's read-modify-write cycles.

var STORAGE_KEY = 'memclip_history';
var STATS_KEY = 'memclip_stats';
var META_KEY = 'memclip_meta';
var SETTINGS_KEY = 'memclip_settings';
var DEFAULT_RETENTION_DAYS = 30;
var DAY_MS = 24 * 60 * 60 * 1000;

var MAX_CLIPS = 1000;
// Per-clip cap. Anything larger is truncated before storage so a single huge
// copy can't blow the extension's storage quota.
var MAX_CLIP_BYTES = 256 * 1024;
// How many times to shed oldest unpinned clips and retry when a write fails
// because the storage quota is exceeded.
var QUOTA_RETRY_LIMIT = 6;

// In-memory debug ring buffer (service workers are ephemeral, so this resets
// when the worker is torn down — that's fine, it's only a live debug view).
var DEBUG_LOGS = [];
var MAX_DEBUG_LOGS = 500;

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function safeSend(sendResponse, response) {
  // sendResponse throws if the channel already closed (popup dismissed, etc).
  try {
    sendResponse(response);
  } catch (e) {
    // nothing to do
  }
}

function addDebugLog(entry) {
  if (!entry || typeof entry !== 'object') return;
  DEBUG_LOGS.push(entry);
  if (DEBUG_LOGS.length > MAX_DEBUG_LOGS) {
    DEBUG_LOGS = DEBUG_LOGS.slice(-MAX_DEBUG_LOGS);
  }
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).substr(2, 9);
}

function detectType(text) {
  if (!text) return 'text';
  var t = text.trim();
  if (/^https?:\/\/[^\s]+$/.test(t)) return 'url';
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return 'email';
  if (/[{}[\]();].*[{}[\]();]/.test(text)) return 'code';
  if (/^(const|let|var|function|import|export|class|def|return|if |for |while )/m.test(text)) return 'code';
  if (/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE|FROM|WHERE)\s/im.test(text)) return 'code';
  if (/^(npm|yarn|docker|git|curl|wget|sudo|cd |mkdir|pip )/m.test(text)) return 'code';
  return 'text';
}

function byteLen(str) {
  try {
    return new TextEncoder().encode(str).length;
  } catch (e) {
    return str ? str.length * 2 : 0;
  }
}

function capText(text) {
  if (byteLen(text) <= MAX_CLIP_BYTES) return { text: text, truncated: false };
  var t = text;
  while (t.length > 0 && byteLen(t) > MAX_CLIP_BYTES) {
    t = t.slice(0, Math.floor(t.length * 0.9));
  }
  return { text: t, truncated: true };
}

function defaultStats() {
  return { totalCopies: 0, totalPastes: 0, topDomains: {}, topPasteDestinations: {} };
}

function sortHistory(history) {
  history.sort(function(a, b) {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    // Among pinned clips, honor a manual order (pinRank) when set, so the user
    // can drag-reorder them. Falls back to newest-first when ranks are absent.
    if (a.pinned && b.pinned) {
      var ar = typeof a.pinRank === 'number' ? a.pinRank : null;
      var br = typeof b.pinRank === 'number' ? b.pinRank : null;
      if (ar !== null && br !== null && ar !== br) return ar - br;
      if (ar !== null && br === null) return -1;
      if (ar === null && br !== null) return 1;
    }
    return (b.timestamp || 0) - (a.timestamp || 0);
  });
  return history;
}

function enforceLimits(history) {
  sortHistory(history);
  if (history.length <= MAX_CLIPS) return history;
  var pinned = [];
  var unpinned = [];
  for (var i = 0; i < history.length; i++) {
    if (history[i].pinned) pinned.push(history[i]);
    else unpinned.push(history[i]);
  }
  var allowed = Math.max(0, MAX_CLIPS - pinned.length);
  unpinned = unpinned.slice(0, allowed);
  return sortHistory(pinned.concat(unpinned));
}

function dropOldestUnpinned(history, n) {
  var removed = 0;
  for (var i = history.length - 1; i >= 0 && removed < n; i--) {
    if (!history[i].pinned) {
      history.splice(i, 1);
      removed++;
    }
  }
  return history;
}

// ---------------------------------------------------------------------------
// Promise-based storage + serialized write queue
// ---------------------------------------------------------------------------

function getAsync(keys) {
  return new Promise(function(resolve) {
    chrome.storage.local.get(keys, function(result) {
      if (chrome.runtime.lastError) {
        console.error('[MemClip][bg] storage read error:', chrome.runtime.lastError);
        resolve({});
        return;
      }
      resolve(result || {});
    });
  });
}

function setAsync(obj) {
  return new Promise(function(resolve, reject) {
    chrome.storage.local.set(obj, function() {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || 'storage set failed'));
        return;
      }
      resolve(true);
    });
  });
}

// Callback-style read used by the read-only query handlers.
function readStorage(keys, callback) {
  getAsync(keys).then(callback);
}

// All writes funnel through this chain so they execute strictly one-at-a-time.
var writeChain = Promise.resolve();
function enqueue(taskFn) {
  // Run taskFn whether or not the previous task resolved or rejected.
  var result = writeChain.then(taskFn, taskFn);
  // Keep the chain alive (never let a rejection poison future tasks).
  writeChain = result.then(function() {}, function() {});
  return result;
}

// Persist history (+ optional stats/meta), trimming oldest unpinned clips and
// retrying if the write fails due to quota limits.
function saveState(history, stats, meta) {
  history = enforceLimits(history);

  function attempt(hist, tries) {
    var obj = {};
    obj[STORAGE_KEY] = hist;
    if (stats !== undefined && stats !== null) obj[STATS_KEY] = stats;
    if (meta !== undefined && meta !== null) obj[META_KEY] = meta;

    return setAsync(obj).then(function() {
      return { success: true, total: hist.length };
    }).catch(function(err) {
      var unpinned = 0;
      for (var i = 0; i < hist.length; i++) if (!hist[i].pinned) unpinned++;
      if (tries < QUOTA_RETRY_LIMIT && unpinned > 0) {
        var drop = Math.max(1, Math.floor(unpinned * 0.1));
        console.warn('[MemClip][bg] write failed (' + err.message + '); shedding ' + drop + ' oldest clips and retrying');
        dropOldestUnpinned(hist, drop);
        return attempt(hist, tries + 1);
      }
      console.error('[MemClip][bg] write failed permanently:', err.message);
      return { success: false, error: err.message, total: hist.length };
    });
  }

  return attempt(history, 0);
}

// ---------------------------------------------------------------------------
// Mutations (all queued)
// ---------------------------------------------------------------------------

function addClip(payload) {
  return enqueue(function() {
    return getAsync([STORAGE_KEY, STATS_KEY]).then(function(result) {
      var history = result[STORAGE_KEY] || [];
      var stats = result[STATS_KEY] || defaultStats();
      stats.topDomains = stats.topDomains || {};

      var capped = capText(payload.text || '');
      var text = capped.text;
      if (!text) return { success: false, error: 'empty text' };

      var dupeIndex = -1;
      for (var i = 0; i < history.length; i++) {
        if (history[i].text === text) { dupeIndex = i; break; }
      }

      if (dupeIndex !== -1) {
        var existing = history.splice(dupeIndex, 1)[0];
        existing.timestamp = Date.now();
        existing.copyCount = (existing.copyCount || 1) + 1;
        existing.source = payload.source;
        existing.hostname = payload.hostname;
        existing.pageTitle = payload.pageTitle;
        existing.scrollY = payload.scrollY || 0;
        history.unshift(existing);
      } else {
        history.unshift({
          id: makeId(),
          text: text,
          source: payload.source,
          hostname: payload.hostname,
          pageTitle: payload.pageTitle,
          scrollY: payload.scrollY || 0,
          timestamp: Date.now(),
          type: detectType(text),
          pinned: false,
          copyCount: 1,
          pasteCount: 0,
          pastedTo: [],
          truncated: capped.truncated || undefined
        });
      }

      stats.totalCopies = (stats.totalCopies || 0) + 1;
      if (payload.hostname) {
        stats.topDomains[payload.hostname] = (stats.topDomains[payload.hostname] || 0) + 1;
      }

      return saveState(history, stats);
    });
  });
}

function recordPaste(payload) {
  return enqueue(function() {
    return getAsync([STORAGE_KEY, STATS_KEY]).then(function(result) {
      var history = result[STORAGE_KEY] || [];
      var stats = result[STATS_KEY] || defaultStats();
      stats.topPasteDestinations = stats.topPasteDestinations || {};

      var text = (payload.text || '').trim();
      if (!text) return { success: false, error: 'empty text' };

      var clip = null;
      for (var i = 0; i < history.length; i++) {
        if (history[i].text === text) { clip = history[i]; break; }
      }

      if (!clip) {
        clip = {
          id: makeId(),
          text: text,
          source: payload.destUrl,
          hostname: payload.destHostname,
          pageTitle: payload.destTitle,
          scrollY: 0,
          timestamp: Date.now(),
          type: detectType(text),
          pinned: false,
          copyCount: 0,
          pasteCount: 0,
          pastedTo: [],
          externalOrigin: true
        };
        history.unshift(clip);
      }

      clip.pasteCount = (clip.pasteCount || 0) + 1;
      clip.lastPasted = Date.now();
      if (!clip.pastedTo) clip.pastedTo = [];
      clip.pastedTo.unshift({
        url: payload.destUrl,
        hostname: payload.destHostname,
        title: payload.destTitle,
        timestamp: Date.now()
      });
      if (clip.pastedTo.length > 10) clip.pastedTo = clip.pastedTo.slice(0, 10);

      stats.totalPastes = (stats.totalPastes || 0) + 1;
      if (payload.destHostname) {
        stats.topPasteDestinations[payload.destHostname] =
          (stats.topPasteDestinations[payload.destHostname] || 0) + 1;
      }

      return saveState(history, stats);
    });
  });
}

function deleteClip(id) {
  return enqueue(function() {
    return getAsync([STORAGE_KEY]).then(function(result) {
      var history = result[STORAGE_KEY] || [];
      var next = history.filter(function(clip) { return clip.id !== id; });
      return saveState(next).then(function(res) {
        res.removed = history.length - next.length;
        return res;
      });
    });
  });
}

function clearAll() {
  return enqueue(function() {
    return getAsync([STORAGE_KEY]).then(function(result) {
      var history = result[STORAGE_KEY] || [];
      var kept = history.filter(function(clip) { return clip.pinned; });

      // Rebuild stats from survivors so the Stats view can't show phantom counts.
      var stats = defaultStats();
      kept.forEach(function(clip) {
        var copies = clip.copyCount || 1;
        stats.totalCopies += copies;
        if (clip.hostname) stats.topDomains[clip.hostname] = (stats.topDomains[clip.hostname] || 0) + copies;
        stats.totalPastes += clip.pasteCount || 0;
        (clip.pastedTo || []).forEach(function(p) {
          if (p.hostname) stats.topPasteDestinations[p.hostname] = (stats.topPasteDestinations[p.hostname] || 0) + 1;
        });
      });

      return saveState(kept, stats).then(function(res) {
        res.kept = kept.length;
        return res;
      });
    });
  });
}

// Recompute stats from the clips themselves so an import (or clear) can never
// leave phantom counts behind.
function rebuildStats(history) {
  var stats = defaultStats();
  history.forEach(function(clip) {
    var copies = clip.copyCount || 0;
    stats.totalCopies += copies;
    if (clip.hostname && copies) {
      stats.topDomains[clip.hostname] = (stats.topDomains[clip.hostname] || 0) + copies;
    }
    stats.totalPastes += clip.pasteCount || 0;
    (clip.pastedTo || []).forEach(function(p) {
      if (p && p.hostname) {
        stats.topPasteDestinations[p.hostname] = (stats.topPasteDestinations[p.hostname] || 0) + 1;
      }
    });
  });
  return stats;
}

// Coerce an untrusted, imported record into a well-formed clip (or null to
// drop it). Never trusts incoming types — a hand-edited or foreign backup must
// not be able to corrupt the store.
function sanitizeImportedClip(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var text = typeof raw.text === 'string' ? raw.text : '';
  var capped = capText(text);
  text = capped.text;
  if (!text) return null;

  var clip = {
    id: (typeof raw.id === 'string' && raw.id) ? raw.id : makeId(),
    text: text,
    source: typeof raw.source === 'string' ? raw.source : '',
    hostname: typeof raw.hostname === 'string' ? raw.hostname : '',
    pageTitle: typeof raw.pageTitle === 'string' ? raw.pageTitle : '',
    scrollY: typeof raw.scrollY === 'number' ? raw.scrollY : 0,
    timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : Date.now(),
    type: typeof raw.type === 'string' ? raw.type : detectType(text),
    pinned: !!raw.pinned,
    copyCount: typeof raw.copyCount === 'number' ? raw.copyCount : (raw.externalOrigin ? 0 : 1),
    pasteCount: typeof raw.pasteCount === 'number' ? raw.pasteCount : 0,
    pastedTo: Array.isArray(raw.pastedTo) ? raw.pastedTo.slice(0, 10) : []
  };
  if (raw.truncated || capped.truncated) clip.truncated = true;
  if (raw.externalOrigin) clip.externalOrigin = true;
  if (typeof raw.pinRank === 'number') clip.pinRank = raw.pinRank;
  if (typeof raw.lastPasted === 'number') clip.lastPasted = raw.lastPasted;
  return clip;
}

// Import a backup. mode 'merge' (default) folds clips into the current history
// (deduping by text, OR-ing pinned, keeping the higher counts/newer timestamp);
// mode 'replace' swaps history wholesale. Settings are only restored on a full
// replace so a cross-device merge can't silently clobber local privacy choices.
function importData(payload, mode) {
  mode = (mode === 'replace') ? 'replace' : 'merge';
  return enqueue(function() {
    return getAsync([STORAGE_KEY]).then(function(result) {
      var existing = result[STORAGE_KEY] || [];

      var rawClips = [];
      if (Array.isArray(payload)) rawClips = payload;
      else if (payload && Array.isArray(payload.clips)) rawClips = payload.clips;
      else if (payload && Array.isArray(payload.history)) rawClips = payload.history;
      else if (payload && Array.isArray(payload[STORAGE_KEY])) rawClips = payload[STORAGE_KEY];

      var imported = [];
      for (var i = 0; i < rawClips.length; i++) {
        var c = sanitizeImportedClip(rawClips[i]);
        if (c) imported.push(c);
      }

      var added = 0, updated = 0, skipped = 0;
      var finalHistory;

      if (mode === 'replace') {
        finalHistory = imported;
        added = imported.length;
      } else {
        var byText = {};
        for (var j = 0; j < existing.length; j++) byText[existing[j].text] = existing[j];

        imported.forEach(function(c) {
          var match = byText[c.text];
          if (!match) {
            existing.push(c);
            byText[c.text] = c;
            added++;
          } else {
            var changed = false;
            if (c.pinned && !match.pinned) { match.pinned = true; changed = true; }
            if ((c.copyCount || 0) > (match.copyCount || 0)) { match.copyCount = c.copyCount; changed = true; }
            if ((c.pasteCount || 0) > (match.pasteCount || 0)) { match.pasteCount = c.pasteCount; changed = true; }
            if ((c.timestamp || 0) > (match.timestamp || 0)) { match.timestamp = c.timestamp; changed = true; }
            if (changed) updated++; else skipped++;
          }
        });
        finalHistory = existing;
      }

      // Guarantee unique ids (id collisions across files would break selection).
      var seenIds = {};
      finalHistory.forEach(function(c) {
        if (!c.id || seenIds[c.id]) c.id = makeId();
        seenIds[c.id] = true;
      });

      var stats = rebuildStats(finalHistory);

      var sourceSettings = (payload && payload.settings && typeof payload.settings === 'object')
        ? payload.settings
        : (payload && payload[SETTINGS_KEY] && typeof payload[SETTINGS_KEY] === 'object')
          ? payload[SETTINGS_KEY]
          : null;

      return saveState(finalHistory, stats).then(function(res) {
        function done() {
          res.added = added;
          res.updated = updated;
          res.skipped = skipped;
          res.total = finalHistory.length;
          return res;
        }
        if (mode === 'replace' && sourceSettings) {
          var extra = {};
          extra[SETTINGS_KEY] = sourceSettings;
          return setAsync(extra).then(done, done);
        }
        return done();
      });
    });
  });
}

function pinClip(id) {
  return enqueue(function() {
    return getAsync([STORAGE_KEY]).then(function(result) {
      var history = result[STORAGE_KEY] || [];
      var pinnedNow = false;
      for (var i = 0; i < history.length; i++) {
        if (history[i].id === id) {
          history[i].pinned = !history[i].pinned;
          pinnedNow = history[i].pinned;
          if (!pinnedNow) delete history[i].pinRank; // clear manual order on unpin
          break;
        }
      }
      return saveState(history).then(function(res) {
        res.pinned = pinnedNow;
        return res;
      });
    });
  });
}

function deleteClips(ids) {
  return enqueue(function() {
    var idSet = {};
    (ids || []).forEach(function(id) { idSet[id] = true; });
    return getAsync([STORAGE_KEY]).then(function(result) {
      var history = result[STORAGE_KEY] || [];
      var next = history.filter(function(clip) { return !idSet[clip.id]; });
      return saveState(next).then(function(res) {
        res.removed = history.length - next.length;
        return res;
      });
    });
  });
}

// Persist a manual ordering for pinned clips. `orderIds` is the desired order
// (top-first) of pinned clip ids; we stamp each with an ascending pinRank.
function reorderPinned(orderIds) {
  return enqueue(function() {
    return getAsync([STORAGE_KEY]).then(function(result) {
      var history = result[STORAGE_KEY] || [];
      var rankOf = {};
      (orderIds || []).forEach(function(id, i) { rankOf[id] = i; });
      history.forEach(function(clip) {
        if (clip.pinned && rankOf[clip.id] !== undefined) {
          clip.pinRank = rankOf[clip.id];
        }
      });
      return saveState(history).then(function(res) {
        res.ordered = (orderIds || []).length;
        return res;
      });
    });
  });
}

function purgeOldClips() {
  return enqueue(function() {
    return getAsync([STORAGE_KEY, META_KEY]).then(function(result) {
      var history = result[STORAGE_KEY] || [];
      var meta = result[META_KEY] || {};
      var days = typeof meta.retentionDays === 'number' ? meta.retentionDays : DEFAULT_RETENTION_DAYS;
      meta.lastPurge = Date.now();

      if (!days || days <= 0) {
        // 0 == keep forever; just record the purge time.
        return setAsync((function() { var o = {}; o[META_KEY] = meta; return o; })())
          .then(function() { return { success: true, removed: 0 }; })
          .catch(function(err) { return { success: false, error: err.message, removed: 0 }; });
      }

      var cutoff = Date.now() - days * DAY_MS;
      var kept = history.filter(function(clip) {
        return clip.pinned || (clip.timestamp || 0) >= cutoff;
      });
      var removed = history.length - kept.length;

      return saveState(kept, undefined, meta).then(function(res) {
        res.removed = removed;
        return res;
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Read-only queries (no queue needed; storage reads are atomic snapshots)
// ---------------------------------------------------------------------------

function getClips(query, limit, callback) {
  readStorage([STORAGE_KEY], function(result) {
    var history = result[STORAGE_KEY] || [];
    sortHistory(history);

    if (query && query.trim()) {
      var q = query.toLowerCase().trim();
      history = history.filter(function(clip) {
        return (clip.text && clip.text.toLowerCase().indexOf(q) !== -1) ||
               (clip.hostname && clip.hostname.toLowerCase().indexOf(q) !== -1) ||
               (clip.pageTitle && clip.pageTitle.toLowerCase().indexOf(q) !== -1);
      });
    }

    var max = typeof limit === 'number' && limit > 0 ? limit : 200;
    callback({ success: true, clips: history.slice(0, max) });
  });
}

function getStats(callback) {
  readStorage([STORAGE_KEY, STATS_KEY], function(result) {
    var history = result[STORAGE_KEY] || [];
    var stats = result[STATS_KEY] || {};

    var domainCounts = stats.topDomains || {};
    if (Object.keys(domainCounts).length === 0) {
      for (var i = 0; i < history.length; i++) {
        var hn = history[i].hostname;
        if (hn) domainCounts[hn] = (domainCounts[hn] || 0) + 1;
      }
    }

    function toSortedPairs(obj) {
      return Object.keys(obj || {}).map(function(k) {
        return [k, obj[k]];
      }).sort(function(a, b) { return b[1] - a[1]; }).slice(0, 10);
    }

    callback({
      success: true,
      totalCopies: stats.totalCopies || history.length,
      totalPastes: stats.totalPastes || 0,
      topDomains: toSortedPairs(domainCounts),
      topPasteDestinations: toSortedPairs(stats.topPasteDestinations)
    });
  });
}

function getDomains(callback) {
  readStorage([STORAGE_KEY], function(result) {
    var history = result[STORAGE_KEY] || [];
    var map = {};
    for (var i = 0; i < history.length; i++) {
      var domain = history[i].hostname || 'Unknown';
      map[domain] = (map[domain] || 0) + 1;
    }
    var domains = Object.keys(map).map(function(d) {
      return { domain: d, count: map[d] };
    }).sort(function(a, b) { return b.count - a.count; });
    callback({ success: true, domains: domains });
  });
}

function openSource(clip, callback) {
  if (!clip || !clip.source) {
    callback({ success: false, error: 'no source' });
    return;
  }
  chrome.tabs.create({ url: clip.source }, function(tab) {
    if (chrome.runtime.lastError || !tab) {
      console.error('[MemClip][bg] openSource error:', chrome.runtime.lastError);
      callback({ success: false });
      return;
    }
    if (clip.scrollY && clip.scrollY > 0) {
      var listener = function(tabId, info) {
        if (tabId === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          try {
            chrome.tabs.sendMessage(tab.id, { type: 'SCROLL_TO', scrollY: clip.scrollY });
          } catch (e) {}
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    }
    callback({ success: true, tabId: tab.id });
  });
}

// ---------------------------------------------------------------------------
// Scheduled retention purge
// ---------------------------------------------------------------------------

function maybeScheduledPurge() {
  readStorage([META_KEY], function(result) {
    var meta = result[META_KEY] || {};
    var last = meta.lastPurge || 0;
    if (Date.now() - last >= DAY_MS) {
      purgeOldClips();
    }
  });
}

chrome.runtime.onInstalled.addListener(maybeScheduledPurge);
chrome.runtime.onStartup.addListener(maybeScheduledPurge);

// ---------------------------------------------------------------------------
// Window management (resizable pop-out instead of a fixed dropdown)
// ---------------------------------------------------------------------------

var memclipWindowId = null;
var WINDOW_BOUNDS_KEY = 'memclip_window_bounds';
var DEFAULT_BOUNDS = { width: 420, height: 620 };

function openMemclipWindow() {
  if (memclipWindowId !== null) {
    chrome.windows.update(memclipWindowId, { focused: true }, function() {
      if (chrome.runtime.lastError) {
        memclipWindowId = null;
        openMemclipWindow();
      }
    });
    return;
  }
  // The service worker is ephemeral: if it was torn down while the pop-out was
  // open, memclipWindowId is gone. Recover it by looking for an existing popup
  // tab instead of blindly spawning a duplicate window.
  recoverExistingWindow(function(foundId) {
    if (foundId !== null) {
      memclipWindowId = foundId;
      chrome.windows.update(foundId, { focused: true }, function() {
        if (chrome.runtime.lastError) { memclipWindowId = null; createMemclipWindow(); }
      });
    } else {
      createMemclipWindow();
    }
  });
}

function recoverExistingWindow(callback) {
  var popupUrl = chrome.runtime.getURL('popup.html');
  try {
    chrome.tabs.query({ url: popupUrl }, function(tabs) {
      if (chrome.runtime.lastError || !tabs || !tabs.length) { callback(null); return; }
      var withWindow = tabs.filter(function(t) { return typeof t.windowId === 'number'; });
      callback(withWindow.length ? withWindow[0].windowId : null);
    });
  } catch (e) {
    callback(null);
  }
}

function createMemclipWindow() {
  // Restore the user's last window size/position so the pop-out remembers how
  // they like it. Falls back to sensible defaults on first run.
  getAsync([WINDOW_BOUNDS_KEY]).then(function(res) {
    var b = res[WINDOW_BOUNDS_KEY] || {};
    var opts = {
      url: chrome.runtime.getURL('popup.html'),
      type: 'popup',
      width: clampDim(b.width, DEFAULT_BOUNDS.width, 320, 2000),
      height: clampDim(b.height, DEFAULT_BOUNDS.height, 360, 2000)
    };
    if (typeof b.left === 'number' && typeof b.top === 'number') {
      opts.left = Math.max(0, Math.round(b.left));
      opts.top = Math.max(0, Math.round(b.top));
    }
    chrome.windows.create(opts, function(win) {
      if (chrome.runtime.lastError || !win) {
        console.error('[MemClip][bg] window create error:', chrome.runtime.lastError);
        return;
      }
      memclipWindowId = win.id;
    });
  });
}

function clampDim(val, fallback, min, max) {
  if (typeof val !== 'number' || isNaN(val)) return fallback;
  return Math.min(max, Math.max(min, Math.round(val)));
}

function saveWindowBounds(win) {
  if (!win || win.id !== memclipWindowId) return;
  var bounds = { width: win.width, height: win.height, left: win.left, top: win.top };
  setAsync((function() { var o = {}; o[WINDOW_BOUNDS_KEY] = bounds; return o; })())
    .catch(function() {});
}

// Persist size/position as the user resizes or moves the window.
if (chrome.windows.onBoundsChanged) {
  chrome.windows.onBoundsChanged.addListener(saveWindowBounds);
}

// Fallback for browsers that don't fire onBoundsChanged reliably: whenever
// focus changes, snapshot our window's current bounds.
if (chrome.windows.onFocusChanged) {
  chrome.windows.onFocusChanged.addListener(function() {
    if (memclipWindowId === null) return;
    chrome.windows.get(memclipWindowId, function(win) {
      if (chrome.runtime.lastError || !win) return;
      saveWindowBounds(win);
    });
  });
}

chrome.windows.onRemoved.addListener(function(windowId) {
  if (windowId === memclipWindowId) {
    // Capture final bounds before we forget the id (covers browsers without
    // onBoundsChanged support).
    memclipWindowId = null;
  }
});

chrome.action.onClicked.addListener(openMemclipWindow);

chrome.commands.onCommand.addListener(function(command) {
  if (command === 'toggle-memclip') {
    openMemclipWindow();
  }
});

// ---------------------------------------------------------------------------
// Message router
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  if (!message || !message.type) return false;

  switch (message.type) {
    case 'ADD_CLIP':
      addClip(message.payload || {}).then(function(r) { safeSend(sendResponse, r); });
      return true;
    case 'RECORD_PASTE':
      recordPaste(message.payload || {}).then(function(r) { safeSend(sendResponse, r); });
      return true;
    case 'GET_CLIPS':
      getClips(message.query, message.limit, function(r) { safeSend(sendResponse, r); });
      return true;
    case 'GET_STATS':
      getStats(function(r) { safeSend(sendResponse, r); });
      return true;
    case 'GET_DOMAINS':
      getDomains(function(r) { safeSend(sendResponse, r); });
      return true;
    case 'DELETE_CLIP':
      deleteClip(message.id).then(function(r) { safeSend(sendResponse, r); });
      return true;
    case 'DELETE_CLIPS':
      deleteClips(message.ids || []).then(function(r) { safeSend(sendResponse, r); });
      return true;
    case 'REORDER_PINNED':
      reorderPinned(message.order || []).then(function(r) { safeSend(sendResponse, r); });
      return true;
    case 'CLEAR_ALL':
      clearAll().then(function(r) { safeSend(sendResponse, r); });
      return true;
    case 'IMPORT_DATA':
      importData(message.payload, message.mode).then(function(r) { safeSend(sendResponse, r); });
      return true;
    case 'PIN_CLIP':
      pinClip(message.id).then(function(r) { safeSend(sendResponse, r); });
      return true;
    case 'OPEN_SOURCE':
      openSource(message.clip, function(r) { safeSend(sendResponse, r); });
      return true;
    case 'PURGE_OLD_CLIPS':
      purgeOldClips().then(function(r) { safeSend(sendResponse, r || { success: true }); });
      return true;
    case 'DEBUG_LOG':
      try { addDebugLog(message.data || {}); } catch (e) {}
      safeSend(sendResponse, { received: true });
      return true;
    case 'GET_DEBUG_LOGS':
      try {
        safeSend(sendResponse, { logs: DEBUG_LOGS.slice(-200) });
      } catch (e) {
        safeSend(sendResponse, { logs: [] });
      }
      return true;
    case 'CLEAR_DEBUG_LOGS':
      DEBUG_LOGS = [];
      safeSend(sendResponse, { cleared: true });
      return true;
  }
  return false;
});

// Expose internals for the Node test harness (no effect inside the browser).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    addClip: addClip, recordPaste: recordPaste, deleteClip: deleteClip,
    deleteClips: deleteClips, reorderPinned: reorderPinned,
    clearAll: clearAll, pinClip: pinClip, purgeOldClips: purgeOldClips,
    importData: importData, rebuildStats: rebuildStats, sanitizeImportedClip: sanitizeImportedClip,
    getClips: getClips, getStats: getStats, getDomains: getDomains,
    saveState: saveState, enforceLimits: enforceLimits, capText: capText,
    detectType: detectType, sortHistory: sortHistory,
    _constants: { MAX_CLIPS: MAX_CLIPS, MAX_CLIP_BYTES: MAX_CLIP_BYTES }
  };
}
