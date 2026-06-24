// MemClip Content Script
// Detects copies/pastes, applies the privacy gate (denylist, password fields,
// sensitive data, incognito), then hands the capture to the background service
// worker via a message. The background is the SINGLE writer to
// chrome.storage.local: funneling every mutation through its serialized queue
// is what prevents concurrent copies in multiple tabs from clobbering each
// other's read-modify-write cycles. The popup live-updates via
// chrome.storage.onChanged once the background commits.

(function() {
  if (window.__memclip_loaded) return;
  window.__memclip_loaded = true;

  // Production build flag. Set to true only when debugging — gates all verbose
  // logging so a released build is silent (errors still surface).
  var DEBUG = false;

  // Per-clip cap so one huge copy isn't shipped over the message channel. The
  // background enforces the authoritative byte cap before storage.
  var MAX_CLIP_CHARS = 200000;
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
      // The extension was reloaded/updated after this page loaded, so this
      // content script is orphaned and can't reach storage. Tell the user
      // instead of failing silently (showIndicator uses only the page DOM).
      debugLog('content', 'extension context invalidated — refresh the page');
      showIndicator('MemClip: refresh this page to capture');
      return;
    }

    try {
      chrome.runtime.sendMessage({
        type: 'ADD_CLIP',
        payload: {
          text: text,
          source: window.location.href,
          hostname: window.location.hostname,
          pageTitle: document.title,
          scrollY: Math.round(window.scrollY || 0)
        }
      }, function(res) {
        if (chrome.runtime.lastError) {
          debugLog('error', 'ADD_CLIP failed', chrome.runtime.lastError.message);
          return;
        }
        if (res && res.success) {
          debugLog('content', 'Clip saved');
          showIndicator('Saved to MemClip');
        } else if (res && res.skipped) {
          debugLog('content', 'Copy skipped by background (' + res.skipped + ')');
        }
      });
    } catch (e) {
      debugLog('error', 'ADD_CLIP threw', e && e.message);
    }
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
      debugLog('content', 'extension context invalidated — refresh the page');
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

    try {
      chrome.runtime.sendMessage({
        type: 'RECORD_PASTE',
        payload: {
          text: text,
          destUrl: destUrl,
          destHostname: destHostname,
          destTitle: destTitle
        }
      }, function(res) {
        if (chrome.runtime.lastError) {
          debugLog('error', 'RECORD_PASTE failed', chrome.runtime.lastError.message);
          return;
        }
        debugLog('content', 'Paste recorded to', destHostname);
      });
    } catch (e) {
      debugLog('error', 'RECORD_PASTE threw', e && e.message);
    }
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
