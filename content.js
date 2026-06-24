// MemClip Content Script
// Writes captured copies/pastes DIRECTLY to chrome.storage.local. This is the
// most reliable path: it doesn't depend on the background service worker being
// awake. The popup live-updates via chrome.storage.onChanged, so direct writes
// show up immediately.
// DEBUG BUILD: explicit console logging on every stage.

(function() {
  if (window.__memclip_loaded) return;
  window.__memclip_loaded = true;

  // Production build flag. Set to true only when debugging — gates all verbose
  // logging so a released build is silent (errors still surface).
  var DEBUG = false;

  var STORAGE_KEY = 'memclip_history';
  var STATS_KEY = 'memclip_stats';
  var MAX_CLIPS = 1000;
  // Per-clip cap so one huge copy can't blow the storage quota.
  var MAX_CLIP_CHARS = 200000;
  // On a quota failure, shed oldest unpinned clips and retry up to N times.
  var QUOTA_RETRY_LIMIT = 6;
  // Cap how many domain/destination keys we keep in stats (prevents unbounded
  // growth of the stats maps over the lifetime of the extension).
  var MAX_STAT_ENTRIES = 250;
  var copyHandled = false;
  var pasteHandled = false;
  var lastCopiedText = '';
  var lastCopyTime = 0;

  debugLog('content', 'loaded', window.location.href);

  function debugLog(category, message, data) {
    // Errors always surface; everything else only when DEBUG is on.
    if (category === 'error') {
      console.error('[MemClip][error] ' + message, data !== null && data !== undefined ? data : '');
    } else if (DEBUG) {
      console.log('[MemClip][' + category + '] ' + message, data !== null && data !== undefined ? data : '');
    }
    if (!DEBUG) return; // don't wake the service worker with debug traffic in prod
    var entry = { time: Date.now(), category: category, message: message, data: data || null };
    try {
      chrome.runtime.sendMessage({ type: 'DEBUG_LOG', data: entry });
    } catch (e) {}
  }

  // chrome.* throws "Extension context invalidated" in content scripts that
  // were injected before the extension was reloaded. Guard every storage call.
  function storageAvailable() {
    try {
      return !!(chrome && chrome.storage && chrome.storage.local && chrome.runtime && chrome.runtime.id);
    } catch (e) {
      return false;
    }
  }

  // --- Security / privacy (Phase 2) ---
  var SETTINGS_KEY = 'memclip_settings';
  var settings = {
    ignoreSensitive: true,    // skip card numbers / keys / private keys
    skipPasswordFields: true, // skip copies/pastes in <input type=password>
    captureIncognito: false,  // do not capture in incognito by default
    denylist: []              // hostnames to never capture on
  };

  var IS_INCOGNITO = (function() {
    try { return !!(chrome.extension && chrome.extension.inIncognitoContext); }
    catch (e) { return false; }
  })();

  function loadSettings() {
    if (!storageAvailable()) return;
    try {
      chrome.storage.local.get([SETTINGS_KEY], function(res) {
        if (chrome.runtime.lastError) return;
        var s = res && res[SETTINGS_KEY];
        if (s && typeof s === 'object') {
          settings.ignoreSensitive = s.ignoreSensitive !== false;
          settings.skipPasswordFields = s.skipPasswordFields !== false;
          settings.captureIncognito = s.captureIncognito === true;
          settings.denylist = Array.isArray(s.denylist) ? s.denylist : [];
        }
      });
    } catch (e) {}
  }
  loadSettings();
  try {
    chrome.storage.onChanged.addListener(function(changes, area) {
      if (area === 'local' && changes[SETTINGS_KEY]) loadSettings();
    });
  } catch (e) {}

  function hostnameDenied(hostname) {
    if (!hostname || !settings.denylist || !settings.denylist.length) return false;
    var h = hostname.toLowerCase();
    for (var i = 0; i < settings.denylist.length; i++) {
      var d = String(settings.denylist[i] || '').toLowerCase().trim();
      if (!d) continue;
      // exact host, or domain suffix match (denying "example.com" also denies "a.example.com")
      if (h === d || h.slice(-(d.length + 1)) === ('.' + d)) return true;
    }
    return false;
  }

  function isPasswordContext() {
    try {
      var el = document.activeElement;
      while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
      if (el && el.tagName === 'INPUT') {
        var type = ((el.getAttribute && el.getAttribute('type')) || el.type || '').toLowerCase();
        if (type === 'password') return true;
      }
    } catch (e) {}
    return false;
  }

  function luhnValid(digits) {
    var sum = 0, alt = false;
    for (var i = digits.length - 1; i >= 0; i--) {
      var n = digits.charCodeAt(i) - 48;
      if (n < 0 || n > 9) return false;
      if (alt) { n *= 2; if (n > 9) n -= 9; }
      sum += n;
      alt = !alt;
    }
    return sum % 10 === 0;
  }

  // High-confidence sensitive patterns only, to avoid swallowing legit copies.
  function looksSensitive(text) {
    if (!text) return false;
    var t = text.trim();
    var compact = t.replace(/[\s-]/g, '');
    if (/^\d{13,19}$/.test(compact) && luhnValid(compact)) return true;       // credit card
    if (/^\d{3}-\d{2}-\d{4}$/.test(t)) return true;                            // US SSN
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(t)) return true;            // private key
    if (/(AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|ghs_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_\-]{20,})/.test(t)) return true; // tokens
    return false;
  }

  // Returns a non-empty reason string if capture should be blocked.
  // Fails open: if any check throws, capture proceeds (privacy checks must
  // never silently break the core copy/paste feature).
  function captureBlockReason(text, hostname) {
    try {
      if (IS_INCOGNITO && !settings.captureIncognito) return 'incognito';
      if (hostnameDenied(hostname)) return 'denylist';
      if (settings.skipPasswordFields && isPasswordContext()) return 'password-field';
      if (settings.ignoreSensitive && looksSensitive(text)) return 'sensitive';
    } catch (e) {
      return '';
    }
    return '';
  }

  // Human-readable reason shown to the user so a deliberate skip never looks
  // like a broken copy.
  function skipMessage(reason) {
    switch (reason) {
      case 'sensitive': return 'MemClip: skipped sensitive data';
      case 'password-field': return 'MemClip: skipped password field';
      case 'denylist': return 'MemClip: site is blocked';
      case 'incognito': return 'MemClip: off in incognito';
      default: return 'MemClip: skipped';
    }
  }

  function extractTextFromClipboardEvent(e) {
    if (e && e.clipboardData) {
      var plain = (e.clipboardData.getData && e.clipboardData.getData('text/plain')) || '';
      var text = (e.clipboardData.getData && e.clipboardData.getData('text')) || '';
      if (!plain) plain = text;
      return plain || text || '';
    }
    return '';
  }

  function getSelectedText() {
    var text = '';

    try {
      var sel = window.getSelection();
      if (sel && sel.toString) text = sel.toString();
    } catch (e) {}

    if (!text) {
      try {
        var sel2 = document.getSelection();
        if (sel2 && sel2.toString) text = sel2.toString();
      } catch (e) {}
    }

    if (!text) {
      try {
        var el = document.activeElement;
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
          if (typeof el.selectionStart === 'number' && typeof el.selectionEnd === 'number') {
            text = el.value.substring(el.selectionStart, el.selectionEnd);
          } else if (el.isContentEditable) {
            text = (el.innerText || el.textContent || '').trim();
          }
        }
      } catch (e) {}
    }

    // window.getSelection() does not reach into shadow roots, so walk down any
    // open shadow trees and read their selection (Chrome supports this).
    if (!text) {
      try {
        var node = document.activeElement;
        while (node && node.shadowRoot) {
          var shadow = node.shadowRoot;
          if (shadow.getSelection) {
            var ssel = shadow.getSelection();
            if (ssel && ssel.toString && ssel.toString()) {
              text = ssel.toString();
              break;
            }
          }
          if (!shadow.activeElement || shadow.activeElement === node) break;
          node = shadow.activeElement;
        }
      } catch (e) {}
    }

    return text ? text.trim() : '';
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

  function showIndicator(text) {
    var existing = document.getElementById('memclip-indicator');
    if (existing) existing.remove();
    if (!document.body) return;

    var div = document.createElement('div');
    div.id = 'memclip-indicator';
    div.textContent = text;
    div.style.cssText = 'position:fixed;bottom:20px;right:20px;background:#1f2937;color:#f59e0b;' +
      'padding:10px 18px;border-radius:999px;font-size:13px;font-family:ui-sans-serif,system-ui,sans-serif;' +
      'z-index:2147483647;border:1px solid #374151;box-shadow:0 10px 15px -3px rgba(0,0,0,.4);' +
      'opacity:0;transition:opacity 0.2s ease;pointer-events:none;';
    document.body.appendChild(div);

    setTimeout(function() { div.style.opacity = '1'; }, 10);
    setTimeout(function() {
      div.style.opacity = '0';
      setTimeout(function() { div.remove(); }, 200);
    }, 1500);
  }

  // Keep history within MAX_CLIPS, never dropping pinned clips.
  function enforceClipLimit(history) {
    if (history.length <= MAX_CLIPS) return history;
    var pinned = [];
    var unpinned = [];
    for (var j = 0; j < history.length; j++) {
      if (history[j].pinned) pinned.push(history[j]);
      else unpinned.push(history[j]);
    }
    var room = Math.max(0, MAX_CLIPS - pinned.length);
    unpinned = unpinned.slice(0, room);
    return pinned.concat(unpinned);
  }

  // Trim a {key: count} map down to the highest-count MAX_STAT_ENTRIES keys.
  function pruneStatsMap(map) {
    if (!map) return {};
    var keys = Object.keys(map);
    if (keys.length <= MAX_STAT_ENTRIES) return map;
    keys.sort(function(a, b) { return map[b] - map[a]; });
    var out = {};
    for (var i = 0; i < MAX_STAT_ENTRIES; i++) out[keys[i]] = map[keys[i]];
    return out;
  }

  // Drop the oldest ~10% of unpinned clips (history is newest-first, so the
  // oldest unpinned sit near the end). Returns a new array; pinned untouched.
  function shedOldestUnpinned(history) {
    var unpinnedIdx = [];
    for (var i = history.length - 1; i >= 0; i--) {
      if (!history[i].pinned) unpinnedIdx.push(i); // oldest-first
    }
    if (!unpinnedIdx.length) return history; // everything is pinned
    var dropCount = Math.max(1, Math.floor(unpinnedIdx.length * 0.1));
    var dropSet = {};
    for (var k = 0; k < dropCount && k < unpinnedIdx.length; k++) dropSet[unpinnedIdx[k]] = true;
    var out = [];
    for (var m = 0; m < history.length; m++) {
      if (!dropSet[m]) out.push(history[m]);
    }
    return out;
  }

  // Single quota-safe write path for both copy and paste. Enforces limits,
  // prunes stats, and on QUOTA_BYTES failure sheds oldest unpinned clips and
  // retries (up to QUOTA_RETRY_LIMIT).
  function commitState(history, stats, label, onSaved) {
    history = enforceClipLimit(history);
    if (stats) {
      stats.topDomains = pruneStatsMap(stats.topDomains);
      stats.topPasteDestinations = pruneStatsMap(stats.topPasteDestinations);
    }

    function attempt(retriesLeft) {
      var saveObj = {};
      saveObj[STORAGE_KEY] = history;
      saveObj[STATS_KEY] = stats;
      chrome.storage.local.set(saveObj, function() {
        if (chrome.runtime.lastError) {
          var msg = chrome.runtime.lastError.message || String(chrome.runtime.lastError);
          if (retriesLeft > 0 && /quota|exceed/i.test(msg)) {
            var before = history.length;
            history = shedOldestUnpinned(history);
            if (history.length < before) {
              debugLog('content', 'Quota hit — shed oldest unpinned, retrying', history.length);
              attempt(retriesLeft - 1);
              return;
            }
          }
          debugLog('error', label + ' write error', msg);
          showIndicator('MemClip: storage full');
          return;
        }
        if (onSaved) onSaved(history);
      });
    }

    attempt(QUOTA_RETRY_LIMIT);
  }

  document.addEventListener('copy', function(e) {
    debugLog('content', 'copy event fired');
    if (copyHandled) return;
    copyHandled = true;
    setTimeout(function() { copyHandled = false; }, 100);

    // Note: e.clipboardData.getData() is spec-guaranteed empty during a `copy`
    // event (it is in write-mode there), so this nearly always returns ''.
    var text = extractTextFromClipboardEvent(e);
    if (!text) text = getSelectedText();

    if (text) {
      saveCopiedClip(text);
      return;
    }

    // No event data and no DOM selection (copy buttons, web components, or a
    // programmatic navigator.clipboard.writeText). Read the real system
    // clipboard once the browser has finished writing to it.
    setTimeout(function() {
      try {
        if (navigator.clipboard && navigator.clipboard.readText) {
          navigator.clipboard.readText().then(function(clipText) {
            clipText = (clipText || '').trim();
            if (clipText) {
              debugLog('content', 'Captured via clipboard.readText fallback', clipText.substring(0, 80));
              saveCopiedClip(clipText);
            } else {
              debugLog('content', 'clipboard.readText empty, nothing to save');
            }
          }).catch(function(err) {
            debugLog('content', 'clipboard.readText failed', err && err.message);
          });
        } else {
          debugLog('content', 'copy handler: no text captured and clipboard API unavailable');
        }
      } catch (err) {
        debugLog('content', 'clipboard.readText threw', err && err.message);
      }
    }, 0);
  });

  function saveCopiedClip(text) {
    if (!text) return;
    if (text.length > MAX_CLIP_CHARS) text = text.slice(0, MAX_CLIP_CHARS);

    var blockReason = captureBlockReason(text, window.location.hostname);
    if (blockReason) {
      debugLog('content', 'Copy skipped (' + blockReason + ')');
      showIndicator(skipMessage(blockReason));
      return;
    }

    var now = Date.now();
    if (text === lastCopiedText && (now - lastCopyTime) < 1000) {
      debugLog('content', 'Rapid duplicate copy suppressed');
      return;
    }
    lastCopiedText = text;
    lastCopyTime = now;

    debugLog('content', 'Copy detected', text.substring(0, 80));

    if (!storageAvailable()) {
      debugLog('content', 'storage unavailable (context invalidated?) — refresh the page');
      return;
    }

    var clipData = {
      id: makeId(),
      text: text,
      source: window.location.href,
      hostname: window.location.hostname,
      pageTitle: document.title,
      scrollY: Math.round(window.scrollY || 0),
      timestamp: Date.now(),
      type: detectType(text),
      pinned: false,
      copyCount: 1,
      pasteCount: 0,
      pastedTo: []
    };

    chrome.storage.local.get([STORAGE_KEY, STATS_KEY], function(result) {
      if (chrome.runtime.lastError) {
        debugLog('error', 'Storage read error', chrome.runtime.lastError.message || String(chrome.runtime.lastError));
        return;
      }

      var history = result[STORAGE_KEY] || [];
      var stats = result[STATS_KEY] || { totalCopies: 0, totalPastes: 0, topDomains: {}, topPasteDestinations: {} };

      var dupeIndex = -1;
      for (var i = 0; i < history.length; i++) {
        if (history[i].text === text) { dupeIndex = i; break; }
      }

      if (dupeIndex !== -1) {
        var existing = history.splice(dupeIndex, 1)[0];
        existing.timestamp = Date.now();
        existing.copyCount = (existing.copyCount || 1) + 1;
        existing.source = clipData.source;
        existing.hostname = clipData.hostname;
        existing.pageTitle = clipData.pageTitle;
        existing.scrollY = clipData.scrollY;
        history.unshift(existing);
        debugLog('content', 'Duplicate moved to top', text.substring(0, 40));
      } else {
        history.unshift(clipData);
        debugLog('content', 'New clip added', text.substring(0, 40));
      }

      stats.totalCopies = (stats.totalCopies || 0) + 1;
      if (clipData.hostname) {
        stats.topDomains = stats.topDomains || {};
        stats.topDomains[clipData.hostname] = (stats.topDomains[clipData.hostname] || 0) + 1;
      }

      commitState(history, stats, 'copy', function(saved) {
        debugLog('content', 'Clip saved', saved.length);
        showIndicator('Saved to MemClip');
      });
    });
  }

  document.addEventListener('paste', function(e) {
    debugLog('content', 'paste event fired');
    if (pasteHandled) return;
    pasteHandled = true;
    setTimeout(function() { pasteHandled = false; }, 100);

    var text = '';
    try {
      if (e.clipboardData) {
        text = e.clipboardData.getData('text') || e.clipboardData.getData('text/plain') || '';
      }
    } catch (err) {
      debugLog('error', 'paste clipboard read error', err && err.message);
      return;
    }

    text = text.trim();
    if (!text) {
      debugLog('content', 'paste handler: empty text');
      return;
    }
    if (text.length > MAX_CLIP_CHARS) text = text.slice(0, MAX_CLIP_CHARS);

    debugLog('content', 'Paste detected', text.substring(0, 80));

    if (!storageAvailable()) {
      debugLog('content', 'storage unavailable (context invalidated?) — refresh the page');
      return;
    }

    var destHostname = window.location.hostname;
    var destUrl = window.location.href;
    var destTitle = document.title;

    var blockReason = captureBlockReason(text, destHostname);
    if (blockReason) {
      debugLog('content', 'Paste skipped (' + blockReason + ')');
      return;
    }

    chrome.storage.local.get([STORAGE_KEY, STATS_KEY], function(result) {
      if (chrome.runtime.lastError) {
        debugLog('error', 'paste storage read error', chrome.runtime.lastError.message || String(chrome.runtime.lastError));
        return;
      }

      var history = result[STORAGE_KEY] || [];
      var stats = result[STATS_KEY] || { totalCopies: 0, totalPastes: 0, topDomains: {}, topPasteDestinations: {} };

      var clip = null;
      for (var i = 0; i < history.length; i++) {
        if (history[i].text === text) { clip = history[i]; break; }
      }

      if (!clip) {
        // Text pasted here was copied somewhere we couldn't capture (another
        // app, a tab without the content script). Record it so the paste is
        // tracked rather than silently dropped.
        debugLog('content', 'paste: no matching clip, creating new entry', text.substring(0, 40));
        clip = {
          id: makeId(),
          text: text,
          source: destUrl,
          hostname: destHostname,
          pageTitle: destTitle,
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
        url: destUrl,
        hostname: destHostname,
        title: destTitle,
        timestamp: Date.now()
      });
      if (clip.pastedTo.length > 10) clip.pastedTo = clip.pastedTo.slice(0, 10);

      stats.totalPastes = (stats.totalPastes || 0) + 1;
      stats.topPasteDestinations = stats.topPasteDestinations || {};
      if (destHostname) {
        stats.topPasteDestinations[destHostname] = (stats.topPasteDestinations[destHostname] || 0) + 1;
      }

      commitState(history, stats, 'paste', function() {
        debugLog('content', 'Paste recorded to', destHostname);
      });
    });
  });

  try {
    chrome.runtime.onMessage.addListener(function(msg) {
      if (msg && msg.type === 'SCROLL_TO' && typeof msg.scrollY === 'number') {
        setTimeout(function() {
          window.scrollTo({ top: msg.scrollY, behavior: 'smooth' });
        }, 500);
      }
    });
  } catch (e) {}

})();
