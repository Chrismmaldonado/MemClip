// MemClip Popup - Rewritten for reliability

var META_KEY = 'memclip_meta';
var STORAGE_VERSION = 2;
var DEFAULT_RETENTION_DAYS = 30;
// Production build flag — gates verbose logging (errors still surface).
var DEBUG = false;

document.addEventListener('DOMContentLoaded', function() {

  // --- INIT STORAGE META ---
  function ensureMeta(callback) {
    chrome.storage.local.get([META_KEY], function(result) {
      if (chrome.runtime.lastError) {
        console.error('[MemClip] Storage get error:', chrome.runtime.lastError);
        if (callback) callback();
        return;
      }
      var meta = result[META_KEY];
      if (!meta || meta.version < STORAGE_VERSION) {
        meta = meta || {};
        meta.version = STORAGE_VERSION;
        meta.retentionDays = meta.retentionDays || DEFAULT_RETENTION_DAYS;
        meta.lastPurge = meta.lastPurge || Date.now();
        chrome.storage.local.set({ [META_KEY]: meta }, function() {
          if (chrome.runtime.lastError) {
            console.error('[MemClip] Storage set error:', chrome.runtime.lastError);
          } else {
            if (DEBUG) console.log('[MemClip] Created/migrated memclip_meta in popup');
          }
          if (callback) callback();
        });
      } else {
        if (callback) callback();
      }
    });
  }

  ensureMeta(function() {
    init();
  });

  function init() {

  // --- STATE ---
  var UI_STATE_KEY = 'memclip_ui_state';
  var STORAGE_KEY = 'memclip_history';
  var SETTINGS_KEY = 'memclip_settings';
  var clips = [];
  var selectedIndex = 0;
  var currentTab = 'all';
  var searchQuery = '';
  var searchTimer = null;
  var savedExpandedDomains = [];
  var previousClipCount = 0;
  var refreshTimer = null;
  var debugConsoleVisible = false;
  var debugLogs = [];
  var debugPollTimer = null;
  // Phase 3 additions
  var typeFilter = 'all';     // all | text | url | email | code
  var dateFilter = 0;         // 0 = any, else days (1/7/30)
  var selectMode = false;     // multi-select toggle
  var selectedIds = {};       // id -> true while in select mode
  var dragSrcId = null;       // pinned-reorder drag source

  // --- ELEMENTS ---
  var mainView = document.getElementById('main-view');
  var settingsView = document.getElementById('settings-view');
  var statsView = document.getElementById('stats-view');
  var detailView = document.getElementById('detail-view');
  var allViews = [mainView, settingsView, statsView, detailView];

  var searchInput = document.getElementById('search-input');
  var clipsList = document.getElementById('clips-list');
  var clipCount = document.getElementById('clip-count');
  var toast = document.getElementById('toast');
  var toastText = document.getElementById('toast-text');

  var debugConsole = document.getElementById('debug-console');
  var debugBody = document.getElementById('debug-body');
  var debugBtn = document.getElementById('debug-btn');
  var debugClose = document.getElementById('debug-close');
  var debugClear = document.getElementById('debug-clear');

  var filterBar = document.getElementById('filter-bar');
  var dateFilterEl = document.getElementById('date-filter');
  var selectBtn = document.getElementById('select-btn');
  var selectBar = document.getElementById('select-bar');
  var selectCountEl = document.getElementById('select-count');

  // --- I18N (cross-browser) ---
  function i18nMessage(key) {
    try {
      if (chrome.i18n && chrome.i18n.getMessage) {
        var m = chrome.i18n.getMessage(key);
        if (m) return m;
      }
    } catch (e) {}
    return null;
  }

  // Replace text/placeholder/title on any element carrying a data-i18n* attr.
  // Falls back to the existing (English) markup if a message is missing, so the
  // UI never goes blank.
  function localizeDom(root) {
    root = root || document;
    root.querySelectorAll('[data-i18n]').forEach(function(el) {
      var msg = i18nMessage(el.getAttribute('data-i18n'));
      if (msg) el.textContent = msg;
    });
    root.querySelectorAll('[data-i18n-placeholder]').forEach(function(el) {
      var msg = i18nMessage(el.getAttribute('data-i18n-placeholder'));
      if (msg) el.setAttribute('placeholder', msg);
    });
    root.querySelectorAll('[data-i18n-title]').forEach(function(el) {
      var msg = i18nMessage(el.getAttribute('data-i18n-title'));
      if (msg) el.setAttribute('title', msg);
    });
  }

  localizeDom(document);

  // --- TERMINAL TYPING REVEAL ---
  var prefersReducedMotion = false;
  try {
    prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch (e) {}

  var revealTimers = [];
  function clearReveals() {
    revealTimers.forEach(function(t) { clearTimeout(t); });
    revealTimers = [];
  }

  // Types `text` into `el` one character at a time with a blinking caret.
  // Instant (no animation) when the user prefers reduced motion.
  function typeReveal(el, text, speed) {
    if (!el) return;
    text = String(text == null ? '' : text);
    if (prefersReducedMotion) { el.textContent = text; return; }
    speed = speed || 18;
    el.textContent = '';
    var caret = document.createElement('span');
    caret.className = 'term-caret';
    caret.textContent = '\u2588';
    el.appendChild(caret);
    var i = 0;
    function step() {
      if (i < text.length) {
        caret.insertAdjacentText('beforebegin', text.charAt(i));
        i++;
        revealTimers.push(setTimeout(step, speed));
      } else {
        revealTimers.push(setTimeout(function() {
          if (caret && caret.parentNode) caret.parentNode.removeChild(caret);
        }, 450));
      }
    }
    step();
  }

  // --- UI STATE PERSISTENCE ---
  function saveUiState() {
    var expandedDomains = [];
    document.querySelectorAll('.domain-group.expanded').forEach(function(group) {
      var nameEl = group.querySelector('.domain-name');
      if (nameEl) expandedDomains.push(nameEl.textContent);
    });

    var state = {
      currentTab: currentTab,
      searchQuery: searchQuery,
      expandedDomains: expandedDomains,
      scrollY: clipsList.scrollTop,
      typeFilter: typeFilter,
      dateFilter: dateFilter
    };
    chrome.storage.local.set({ [UI_STATE_KEY]: state }, function() {
      if (chrome.runtime.lastError) {
        console.error('[MemClip] UI state save error:', chrome.runtime.lastError);
      }
    });
  }

  function restoreUiState() {
    chrome.storage.local.get([UI_STATE_KEY, STORAGE_KEY], function(result) {
      if (chrome.runtime.lastError) {
        console.error('[MemClip] UI state restore error:', chrome.runtime.lastError);
        return;
      }
      var state = result[UI_STATE_KEY];
      if (!state) return;

      if (state.currentTab) {
        currentTab = state.currentTab;
        document.querySelectorAll('.tab').forEach(function(btn) {
          btn.classList.toggle('active', btn.dataset.tab === currentTab);
        });
      }

      if (state.searchQuery) {
        searchQuery = state.searchQuery;
        searchInput.value = searchQuery;
      }

      if (state.typeFilter) {
        typeFilter = state.typeFilter;
        if (filterBar) {
          filterBar.querySelectorAll('.filter-chip').forEach(function(chip) {
            chip.classList.toggle('active', chip.dataset.type === typeFilter);
          });
        }
      }

      if (state.dateFilter) {
        dateFilter = state.dateFilter;
        if (dateFilterEl) dateFilterEl.value = String(dateFilter);
      }

      savedExpandedDomains = state.expandedDomains || [];

      renderClips(false);

      if (state.scrollY) {
        setTimeout(function() {
          clipsList.scrollTop = state.scrollY;
        }, 100);
      }
    });
  }

  restoreUiState();

  // --- DEBUG CONSOLE ---
  function toggleDebugConsole() {
    debugConsoleVisible = !debugConsoleVisible;
    if (debugConsoleVisible) {
      debugConsole.classList.remove('hidden');
      debugBtn.style.color = 'var(--accent)';
      loadDebugLogs();
      debugPollTimer = setInterval(loadDebugLogs, 600);
    } else {
      debugConsole.classList.add('hidden');
      debugBtn.style.color = '';
      if (debugPollTimer) {
        clearInterval(debugPollTimer);
        debugPollTimer = null;
      }
    }
  }

  function loadDebugLogs() {
    try {
      chrome.runtime.sendMessage({ type: 'GET_DEBUG_LOGS' }, function(response) {
        if (chrome.runtime.lastError) return;
        if (!response || !response.logs) return;
        debugLogs = response.logs;
        renderDebugLogs();
      });
    } catch(e) {}
  }

  function renderDebugLogs() {
    if (!debugBody) return;
    if (!debugLogs.length) {
      debugBody.innerHTML = '<div class=\"debug-empty\">No logs yet. Copy or paste something to see events.</div>';
      return;
    }
    var html = '';
    for (var i = 0; i < debugLogs.length; i++) {
      var entry = debugLogs[i];
      var timeStr = new Date(entry.time || Date.now()).toLocaleTimeString();
      var category = (entry.category || 'log').toLowerCase();
      var isError = category === 'error';
      html += '<div class=\"debug-entry\">';
      html += '<span class=\"debug-entry-time\">' + timeStr + '</span>';
      html += '<span class=\"debug-entry-category' + (isError ? ' error' : '') + '\">' + (category || 'log').toUpperCase() + '</span>';
      html += '<span class=\"debug-entry-message\">' + escapeHtml(String(entry.message || '')) + '</span>';
      if (entry.data !== null && entry.data !== undefined) {
        html += '<span class=\"debug-entry-data\">' + escapeHtml(JSON.stringify(entry.data)) + '</span>';
      }
      html += '</div>';
    }
    debugBody.innerHTML = html;
    debugBody.scrollTop = debugBody.scrollHeight;
  }

  if (debugBtn) {
    debugBtn.addEventListener('click', toggleDebugConsole);
  }
  if (debugClose) {
    debugClose.addEventListener('click', toggleDebugConsole);
  }
  if (debugClear) {
    debugClear.addEventListener('click', function() {
      try {
        chrome.runtime.sendMessage({ type: 'CLEAR_DEBUG_LOGS' });
      } catch(e) {}
      debugLogs = [];
      renderDebugLogs();
    });
  }

  // --- NAVIGATION ---
  function showView(view) {
    allViews.forEach(function(v) {
      if (v === view) {
        v.classList.remove('hidden');
      } else {
        v.classList.add('hidden');
      }
    });
    // Terminal-style reveal of the panel title when entering a sub-view.
    var title = view && view.querySelector('.panel-title');
    if (title) {
      var label = title.getAttribute('data-label') || title.textContent;
      title.setAttribute('data-label', label);
      typeReveal(title, label, 16);
    }
  }

  document.getElementById('settings-btn').addEventListener('click', function() {
    showView(settingsView);
    loadSettingsData();
  });

  document.getElementById('stats-btn').addEventListener('click', function() {
    showView(statsView);
    loadStatsData();
  });

  document.getElementById('settings-back').addEventListener('click', function() {
    showView(mainView);
  });

  document.getElementById('stats-back').addEventListener('click', function() {
    showView(mainView);
  });

  document.getElementById('detail-back').addEventListener('click', function() {
    showView(mainView);
  });

  document.getElementById('clear-all-btn').addEventListener('click', function() {
    if (confirm('Clear all clipboard history?\nPinned clips will be kept.')) {
      chrome.runtime.sendMessage({ type: 'CLEAR_ALL' }, function(response) {
        if (chrome.runtime.lastError) {
          console.error('[MemClip] Clear all error:', chrome.runtime.lastError);
          showToast('Error clearing history');
          return;
        }
        showView(mainView);
        loadClips();
        showToast('History cleared');
      });
    }
  });

  // --- PRIVACY & SECURITY SETTINGS ---
  function saveSecuritySettings() {
    var dlEl = document.getElementById('set-denylist');
    var denylist = dlEl ? dlEl.value.split('\n').map(function(x) { return x.trim(); }).filter(Boolean) : [];
    var s = {
      ignoreSensitive: getChecked('set-ignore-sensitive', true),
      skipPasswordFields: getChecked('set-skip-password', true),
      captureIncognito: getChecked('set-capture-incognito', false),
      denylist: denylist
    };
    chrome.storage.local.set({ [SETTINGS_KEY]: s }, function() {
      if (chrome.runtime.lastError) {
        console.error('[MemClip] settings save error:', chrome.runtime.lastError);
        showToast('Error saving settings');
        return;
      }
      showToast('Privacy settings saved');
    });
  }

  function getChecked(id, fallback) {
    var el = document.getElementById(id);
    return el ? el.checked : fallback;
  }

  ['set-ignore-sensitive', 'set-skip-password', 'set-capture-incognito'].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('change', saveSecuritySettings);
  });
  var denylistInput = document.getElementById('set-denylist');
  if (denylistInput) denylistInput.addEventListener('change', saveSecuritySettings);

  var eraseAllBtn = document.getElementById('erase-all-btn');
  if (eraseAllBtn) {
    eraseAllBtn.addEventListener('click', function() {
      if (!confirm('Erase EVERYTHING?\n\nThis permanently deletes all clips (including pinned), stats, and settings. This cannot be undone.')) return;
      chrome.storage.local.clear(function() {
        if (chrome.runtime.lastError) {
          console.error('[MemClip] erase all error:', chrome.runtime.lastError);
          showToast('Error erasing data');
          return;
        }
        clips = [];
        showView(mainView);
        loadClips();
        showToast('All data erased');
      });
    });
  }

  // --- BACKUP: EXPORT / IMPORT ---
  var STATS_KEY = 'memclip_stats';

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  var exportBtn = document.getElementById('export-btn');
  if (exportBtn) {
    exportBtn.addEventListener('click', function() {
      chrome.storage.local.get([STORAGE_KEY, STATS_KEY, SETTINGS_KEY, META_KEY], function(result) {
        if (chrome.runtime.lastError) {
          showToast('Error reading data');
          return;
        }
        var manifest = (chrome.runtime.getManifest && chrome.runtime.getManifest()) || {};
        var payload = {
          app: 'MemClip',
          format: 1,
          version: manifest.version || '',
          exportedAt: new Date().toISOString(),
          clips: result[STORAGE_KEY] || [],
          stats: result[STATS_KEY] || null,
          settings: result[SETTINGS_KEY] || null,
          meta: result[META_KEY] || null
        };
        var json = JSON.stringify(payload, null, 2);
        var blob = new Blob([json], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var d = new Date();
        var name = 'memclip-backup-' + d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + '.json';
        var a = document.createElement('a');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // Revoke after a tick so the download has a chance to start.
        setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
        showToast('Exported ' + (payload.clips.length) + ' clips');
      });
    });
  }

  var importBtn = document.getElementById('import-btn');
  var importFile = document.getElementById('import-file');
  if (importBtn && importFile) {
    importBtn.addEventListener('click', function() { importFile.click(); });

    importFile.addEventListener('change', function() {
      var file = importFile.files && importFile.files[0];
      if (!file) return;

      var reader = new FileReader();
      reader.onload = function() {
        // Reset the input so picking the same file again re-triggers change.
        importFile.value = '';
        var payload;
        try {
          payload = JSON.parse(String(reader.result));
        } catch (e) {
          showToast('Invalid backup file');
          return;
        }

        var count = 0;
        if (Array.isArray(payload)) count = payload.length;
        else if (payload && Array.isArray(payload.clips)) count = payload.clips.length;
        else if (payload && Array.isArray(payload.history)) count = payload.history.length;

        if (!count) {
          showToast('No clips found in file');
          return;
        }

        var merge = confirm(
          'Import ' + count + ' clips?\n\n' +
          'OK = Merge into your current history\n' +
          'Cancel = Replace everything (also restores saved settings)'
        );
        var mode = merge ? 'merge' : 'replace';

        chrome.runtime.sendMessage({ type: 'IMPORT_DATA', payload: payload, mode: mode }, function(response) {
          if (chrome.runtime.lastError || !response || response.success === false) {
            showToast('Import failed');
            return;
          }
          showView(mainView);
          loadClips();
          loadSettingsData();
          var added = response.added || 0;
          var msg = (mode === 'replace')
            ? 'Restored ' + (response.total || 0) + ' clips'
            : 'Imported ' + added + ' new clip' + (added === 1 ? '' : 's');
          showToast(msg);
        });
      };
      reader.onerror = function() {
        importFile.value = '';
        showToast('Could not read file');
      };
      reader.readAsText(file);
    });
  }

  // --- TABS ---
  var tabButtons = document.querySelectorAll('.tab');
  tabButtons.forEach(function(btn) {
    btn.addEventListener('click', function() {
      currentTab = btn.dataset.tab;
      tabButtons.forEach(function(b) { b.classList.remove('active'); });
      btn.classList.add('active');
      selectedIndex = 0;

      if (currentTab === 'domains') {
        renderClips(false);
      } else {
        loadClips(searchQuery, false);
      }

      saveUiState();
    });
  });

  // --- SEARCH ---
  searchInput.addEventListener('input', function() {
    searchQuery = searchInput.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(function() {
      loadClips(searchQuery, false);
      saveUiState();
    }, 200);
  });

  // --- FILTERS ---
  if (filterBar) {
    filterBar.querySelectorAll('.filter-chip').forEach(function(chip) {
      chip.addEventListener('click', function() {
        typeFilter = chip.dataset.type || 'all';
        filterBar.querySelectorAll('.filter-chip').forEach(function(c) {
          c.classList.toggle('active', c === chip);
        });
        selectedIndex = 0;
        loadClips(searchQuery, false);
        saveUiState();
      });
    });
  }
  if (dateFilterEl) {
    dateFilterEl.addEventListener('change', function() {
      dateFilter = parseInt(dateFilterEl.value, 10) || 0;
      selectedIndex = 0;
      loadClips(searchQuery, false);
      saveUiState();
    });
  }

  // --- MULTI-SELECT ---
  function setSelectMode(on) {
    selectMode = !!on;
    selectedIds = {};
    if (selectBtn) selectBtn.classList.toggle('active-toggle', selectMode);
    if (selectBar) selectBar.classList.toggle('hidden', !selectMode);
    updateSelectCount();
    loadClips(searchQuery, false);
  }

  function updateSelectCount() {
    var n = Object.keys(selectedIds).length;
    if (selectCountEl) selectCountEl.textContent = n + ' selected';
  }

  function toggleSelect(id, el, forced) {
    var nowSelected = (forced === undefined) ? !selectedIds[id] : !!forced;
    if (nowSelected) selectedIds[id] = true; else delete selectedIds[id];
    if (el) {
      el.classList.toggle('checked', nowSelected);
      var cb = el.querySelector('.clip-check input');
      if (cb) cb.checked = nowSelected;
    }
    updateSelectCount();
  }

  // Move dragged pinned clip to the position of the target, then persist order.
  function reorderPinnedDrop(srcId, targetId) {
    var pinned = clips.filter(function(c) { return c.pinned; });
    var order = pinned.map(function(c) { return c.id; });
    var from = order.indexOf(srcId);
    var to = order.indexOf(targetId);
    if (from === -1 || to === -1) return;
    order.splice(to, 0, order.splice(from, 1)[0]);
    chrome.runtime.sendMessage({ type: 'REORDER_PINNED', order: order }, function() {
      if (chrome.runtime.lastError) { showToast('Error reordering'); return; }
      loadClips(searchQuery, false);
      showToast('Reordered');
    });
  }

  if (selectBtn) {
    selectBtn.addEventListener('click', function() { setSelectMode(!selectMode); });
  }
  var selectCancel = document.getElementById('select-cancel');
  if (selectCancel) selectCancel.addEventListener('click', function() { setSelectMode(false); });

  var selectDelete = document.getElementById('select-delete');
  if (selectDelete) {
    selectDelete.addEventListener('click', function() {
      var ids = Object.keys(selectedIds);
      if (!ids.length) { showToast('Nothing selected'); return; }
      if (!confirm('Delete ' + ids.length + ' selected clip' + (ids.length !== 1 ? 's' : '') + '?')) return;
      chrome.runtime.sendMessage({ type: 'DELETE_CLIPS', ids: ids }, function() {
        if (chrome.runtime.lastError) { showToast('Error deleting'); return; }
        showToast('Deleted ' + ids.length);
        setSelectMode(false);
      });
    });
  }

  var selectPin = document.getElementById('select-pin');
  if (selectPin) {
    selectPin.addEventListener('click', function() {
      var ids = Object.keys(selectedIds);
      if (!ids.length) { showToast('Nothing selected'); return; }
      // Pin each selected clip that isn't already pinned.
      var pending = 0;
      var pinnedSet = {};
      clips.forEach(function(c) { if (c.pinned) pinnedSet[c.id] = true; });
      ids.forEach(function(id) {
        if (pinnedSet[id]) return;
        pending++;
        chrome.runtime.sendMessage({ type: 'PIN_CLIP', id: id }, function() {
          pending--;
          if (pending <= 0) { showToast('Pinned ' + ids.length); setSelectMode(false); }
        });
      });
      if (pending === 0) { showToast('Already pinned'); setSelectMode(false); }
    });
  }

  // --- RETENTION ---
  var retentionSelect = document.getElementById('retention-select');
  if (retentionSelect) {
    retentionSelect.addEventListener('change', onRetentionChange);
  }

  // --- KEYBOARD ---
  document.addEventListener('keydown', function(e) {
    if (mainView.classList.contains('hidden')) {
      if (e.key === 'Escape') showView(mainView);
      return;
    }

    if (currentTab === 'domains') return;

    var displayedClips = getDisplayedClips();

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (selectedIndex < displayedClips.length - 1) {
        selectedIndex++;
        updateSelection();
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (selectedIndex > 0) {
        selectedIndex--;
        updateSelection();
      }
    } else if (e.key === 'Enter') {
      e.preventDefault();
      var clip = displayedClips[selectedIndex];
      if (clip) copyClip(clip);
    }
  });

  window.addEventListener('beforeunload', saveUiState);

  // --- LIVE UPDATES ---
  // Re-render whenever the background changes stored data. This is event-driven
  // (no polling, no focus-stealing). Crucially it catches updates that DON'T
  // change the clip count — e.g. a paste bumping an existing clip's pasteCount,
  // or a pin toggle — which the old count-based poll silently missed.
  chrome.storage.onChanged.addListener(function(changes, area) {
    if (area !== 'local' || !changes.memclip_history) return;
    if (mainView.classList.contains('hidden')) return;
    if (currentTab === 'domains') {
      renderDomains(false);
    } else {
      loadClips(searchQuery, false);
    }
  });

  // --- LOAD DATA ---
  function isContextValid() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  function loadClips(query, animate) {
    animate = animate === undefined ? false : !!animate;
    if (DEBUG) console.log('[MemClip][popup] loadClips start, query:', query);

    // If the extension was reloaded/updated, an already-open MemClip window is
    // orphaned and can't read storage. Tell the user to reopen it.
    if (!isContextValid()) {
      clipsList.innerHTML = '<div class="empty-state"><p>MemClip was updated</p><span>Close this window and open MemClip again</span></div>';
      return;
    }

    chrome.storage.local.get(['memclip_history'], function(storageResult) {
      if (chrome.runtime.lastError) {
        console.error('[MemClip][popup] Storage read error:', chrome.runtime.lastError);
        clipsList.innerHTML = '<div class="empty-state"><p>Error loading clips</p></div>';
        return;
      }
      var history = storageResult['memclip_history'];
      if (!Array.isArray(history)) history = [];
      if (DEBUG) console.log('[MemClip][popup] raw history length:', history.length);
      if (DEBUG) console.log('[MemClip][popup] first item:', history.length ? JSON.stringify(history[0]).substring(0, 120) : 'none');
      
      // Sort like background.js does (pinned first, manual pinRank among pinned,
      // then newest).
      history.sort(sortClips);

      // Type filter
      if (typeFilter && typeFilter !== 'all') {
        history = history.filter(function(clip) { return (clip.type || 'text') === typeFilter; });
      }

      // Date filter (by copy timestamp; pinned clips always shown)
      if (dateFilter && dateFilter > 0) {
        var cutoff = Date.now() - dateFilter * 86400000;
        history = history.filter(function(clip) { return clip.pinned || (clip.timestamp || 0) >= cutoff; });
      }

      // Search — substring first, then fuzzy subsequence; rank by score.
      if (query && query.trim()) {
        var q = query.toLowerCase().trim();
        var scored = [];
        for (var si = 0; si < history.length; si++) {
          var s = scoreClip(history[si], q);
          if (s > 0) scored.push({ clip: history[si], score: s, idx: si });
        }
        scored.sort(function(a, b) {
          if (b.score !== a.score) return b.score - a.score;
          return a.idx - b.idx;
        });
        history = scored.map(function(x) { return x.clip; });
      }

      history = history.slice(0, 200);
      clips = history;
      previousClipCount = clips.length;
      if (DEBUG) console.log('[MemClip] loadClips direct read:', clips.length, 'clips');
      renderClips(animate);
    });
  }

  function getDisplayedClips() {
    if (currentTab === 'pinned') {
      return clips.filter(function(c) { return c.pinned; });
    }
    return clips;
  }

  function renderClips(animate) {
    animate = animate === undefined ? false : !!animate;
    if (DEBUG) console.log('[MemClip] renderClips called, animate:', animate, 'tab:', currentTab);
    clearReveals();
    clipsList.innerHTML = '';

    // Reorder mode is available on the Pinned tab (when not multi-selecting).
    var reorderMode = (currentTab === 'pinned' && !selectMode);
    clipsList.classList.toggle('select-mode', selectMode);
    clipsList.classList.toggle('reorder-mode', reorderMode);

    var displayedClips = getDisplayedClips();

    // Domains tab
    if (currentTab === 'domains') {
      renderDomains(animate);
      return;
    }

    if (displayedClips.length === 0) {
      var emptyHead = searchQuery ? 'No matches' : (currentTab === 'pinned' ? 'No pinned clips' : 'No clips yet');
      clipsList.innerHTML =
        '<div class="empty-state">' +
          '<p id="empty-head"></p>' +
          '<span>' + (searchQuery ? 'Try different keywords or filters' : 'Copy text on any webpage to get started') + '</span>' +
        '</div>';
      typeReveal(document.getElementById('empty-head'), emptyHead, 22);
      clipCount.textContent = '0 clips';
      return;
    }

    displayedClips.forEach(function(clip, index) {
      var el = createClipElement(clip, index, reorderMode);
      if (animate && index === 0) {
        el.classList.add('clip-new');
      } else if (!prefersReducedMotion && index < 12) {
        // Subtle staggered reveal for the first screenful only (keeps it cheap).
        el.classList.add('reveal');
        el.style.animationDelay = (index * 22) + 'ms';
      }
      clipsList.appendChild(el);
    });

    clipCount.textContent = displayedClips.length + ' clip' + (displayedClips.length !== 1 ? 's' : '');

    if (animate && displayedClips.length > 0) {
      clipsList.scrollTop = 0;
    }
  }

  function getSourcePath(url) {
    if (!url) return '';
    try {
      var u = new URL(url);
      var path = u.pathname;
      if (u.search) path += u.search;
      return path;
    } catch(e) {
      return '';
    }
  }

  var TYPE_LABEL = { url: 'LINK', email: 'MAIL', code: 'CODE', text: '' };

  function createClipElement(clip, index, reorderMode) {
    var div = document.createElement('div');
    var checked = !!selectedIds[clip.id];
    div.className = 'clip-item' + (index === selectedIndex ? ' selected' : '') + (checked ? ' checked' : '');
    div.setAttribute('data-index', index);
    div.setAttribute('data-id', clip.id);

    var pasteInfo = '';
    if (clip.pasteCount && clip.pasteCount > 0) {
      pasteInfo = '<span title="Used ' + clip.pasteCount + ' times">· used ' + clip.pasteCount + 'x</span>';
    }

    var typeLabel = TYPE_LABEL[clip.type || 'text'];
    var typeBadge = typeLabel ? '<span class="clip-type-badge">' + typeLabel + '</span>' : '';

    var sourcePath = getSourcePath(clip.source);
    var sourcePathHtml = sourcePath ? '<span style="color:var(--text-muted);font-size:10px">' + escapeHtml(sourcePath) + '</span>' : '';

    var dragHandleHtml =
      '<span class="drag-handle" title="Drag to reorder">' +
        '<svg width="12" height="14" viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"></circle><circle cx="15" cy="6" r="1.6"></circle><circle cx="9" cy="12" r="1.6"></circle><circle cx="15" cy="12" r="1.6"></circle><circle cx="9" cy="18" r="1.6"></circle><circle cx="15" cy="18" r="1.6"></circle></svg>' +
      '</span>';

    var checkHtml =
      '<label class="clip-check"><input type="checkbox" ' + (checked ? 'checked' : '') + '></label>';

    div.innerHTML =
      dragHandleHtml +
      checkHtml +
      '<div class="clip-content">' +
        '<div class="clip-text type-' + (clip.type || 'text') + '">' + escapeHtml(clip.text) + '</div>' +
        '<div class="clip-meta">' +
          typeBadge +
          '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>' +
          '<span class="clip-hostname" data-action="open" title="' + escapeHtml(clip.source || '') + '">' + escapeHtml(clip.hostname || 'Unknown') + '</span>' +
          sourcePathHtml +
          '<span>· ' + timeAgo(clip.timestamp) + '</span>' +
          pasteInfo +
        '</div>' +
      '</div>' +
      '<div class="clip-actions">' +
        '<button class="btn-icon" data-action="info" title="Details">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12.01" y2="8"></line></svg>' +
        '</button>' +
        '<button class="btn-icon ' + (clip.pinned ? 'clip-pinned' : '') + '" data-action="pin" title="' + (clip.pinned ? 'Unpin' : 'Pin') + '">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="' + (clip.pinned ? 'currentColor' : 'none') + '" stroke="currentColor" stroke-width="2"><path d="M12 17v5M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6a2 2 0 0 0-2-2h-2a2 2 0 0 0-2 2v4.76z"></path></svg>' +
        '</button>' +
        '<button class="btn-icon" data-action="open" title="Open source">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>' +
        '</button>' +
        '<button class="btn-icon" data-action="delete" title="Delete">' +
          '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>' +
        '</button>' +
      '</div>';

    // Drag-to-reorder (Pinned tab only).
    if (reorderMode) {
      div.setAttribute('draggable', 'true');
      div.addEventListener('dragstart', function(e) {
        dragSrcId = clip.id;
        div.classList.add('dragging');
        try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', clip.id); } catch (err) {}
      });
      div.addEventListener('dragend', function() {
        dragSrcId = null;
        div.classList.remove('dragging');
        clipsList.querySelectorAll('.drag-over').forEach(function(n) { n.classList.remove('drag-over'); });
      });
      div.addEventListener('dragover', function(e) {
        e.preventDefault();
        try { e.dataTransfer.dropEffect = 'move'; } catch (err) {}
        div.classList.add('drag-over');
      });
      div.addEventListener('dragleave', function() { div.classList.remove('drag-over'); });
      div.addEventListener('drop', function(e) {
        e.preventDefault();
        div.classList.remove('drag-over');
        if (dragSrcId && dragSrcId !== clip.id) reorderPinnedDrop(dragSrcId, clip.id);
      });
    }

    // Multi-select mode: clicking toggles selection.
    if (selectMode) {
      div.addEventListener('click', function(e) {
        if (e.target.closest('.clip-check')) return; // checkbox handles itself
        toggleSelect(clip.id, div);
      });
      var cb = div.querySelector('.clip-check input');
      if (cb) cb.addEventListener('change', function() { toggleSelect(clip.id, div, cb.checked); });
      return div;
    }

    div.addEventListener('click', function(e) {
      var actionEl = e.target.closest('[data-action]');
      if (actionEl) {
        var action = actionEl.getAttribute('data-action');
        if (action === 'pin') {
          chrome.runtime.sendMessage({ type: 'PIN_CLIP', id: clip.id }, function(response) {
            if (chrome.runtime.lastError) {
              console.error('[MemClip] Pin error:', chrome.runtime.lastError);
              showToast('Error pinning');
              return;
            }
            loadClips(searchQuery, false);
            saveUiState();
          });
        } else if (action === 'delete') {
          // Pinned clips are protected — confirm before removing them, since a
          // pinned clip and its "All" entry are the same object.
          if (clip.pinned && !confirm('This clip is pinned — delete anyway?')) {
            return;
          }
          chrome.runtime.sendMessage({ type: 'DELETE_CLIP', id: clip.id }, function(response) {
            if (chrome.runtime.lastError) {
              console.error('[MemClip] Delete error:', chrome.runtime.lastError);
              showToast('Error deleting');
              return;
            }
            loadClips(searchQuery, false);
            showToast('Deleted');
            saveUiState();
          });
        } else if (action === 'open') {
          chrome.runtime.sendMessage({ type: 'OPEN_SOURCE', clip: clip }, function(response) {
            if (chrome.runtime.lastError) {
              console.error('[MemClip] Open source error:', chrome.runtime.lastError);
              showToast('Error opening source');
              return;
            }
            window.close();
          });
        } else if (action === 'info') {
          showDetail(clip);
        }
      } else {
        copyClip(clip);
      }
    });

    return div;
  }

  function renderDomains(animate) {
    animate = animate === undefined ? false : !!animate;
    chrome.storage.local.get(['memclip_history'], function(storageResult) {
      if (chrome.runtime.lastError) {
        console.error('[MemClip] Storage read error:', chrome.runtime.lastError);
        clipsList.innerHTML = '<div class="empty-state"><p>Error loading clips</p></div>';
        return;
      }
      var history = storageResult['memclip_history'];
      if (!Array.isArray(history)) history = [];
      clipsList.innerHTML = '';

      if (history.length === 0) {
        clipsList.innerHTML = '<div class="empty-state"><p>No clips yet</p></div>';
        return;
      }

      // Build domain map from history
      var domainMap = {};
      for (var i = 0; i < history.length; i++) {
        var domain = history[i].hostname || 'Unknown';
        if (!domainMap[domain]) {
          domainMap[domain] = { count: 0, clips: [] };
        }
        domainMap[domain].count++;
        domainMap[domain].clips.push(history[i]);
      }

      var sorted = Object.keys(domainMap).map(function(key) {
        return { domain: key, count: domainMap[key].count, clips: domainMap[key].clips };
      }).sort(function(a, b) { return b.count - a.count; });

      sorted.forEach(function(domain) {
        var group = document.createElement('div');
        group.className = 'domain-group';

        var header = document.createElement('div');
        header.className = 'domain-header';
        header.innerHTML =
          '<span class="domain-name">' + escapeHtml(domain.domain) + '</span>' +
          '<span class="domain-count">' + domain.count + '</span>';

        var clipsDiv = document.createElement('div');
        clipsDiv.className = 'domain-clips';

        header.addEventListener('click', function() {
          group.classList.toggle('expanded');
          saveUiState();
          if (group.classList.contains('expanded') && clipsDiv.children.length === 0) {
            domain.clips.slice(0, 10).forEach(function(clip, i) {
              clipsDiv.appendChild(createClipElement(clip, i));
            });
          }
        });

        group.appendChild(header);
        group.appendChild(clipsDiv);
        clipsList.appendChild(group);
      });

      // Apply saved expanded state
      savedExpandedDomains.forEach(function(domainName) {
        document.querySelectorAll('.domain-group').forEach(function(group) {
          var nameEl = group.querySelector('.domain-name');
          if (nameEl && nameEl.textContent === domainName) {
            group.classList.add('expanded');
            var clipsDiv = group.querySelector('.domain-clips');
            if (clipsDiv && clipsDiv.children.length === 0) {
              var matchingDomain = sorted.find(function(d) { return d.domain === domainName; });
              if (matchingDomain) {
                matchingDomain.clips.slice(0, 10).forEach(function(clip, i) {
                  clipsDiv.appendChild(createClipElement(clip, i));
                });
              }
            }
          }
        });
      });

      clipCount.textContent = sorted.length + ' site' + (sorted.length !== 1 ? 's' : '');
    });
  }

  // --- DETAIL VIEW ---
  function showDetail(clipRef) {
    // Re-read the latest version from storage so paste counts / destinations
    // are current even if this row came from an older snapshot.
    chrome.storage.local.get(['memclip_history'], function(result) {
      var list = (result && result.memclip_history) || [];
      var fresh = clipRef;
      for (var i = 0; i < list.length; i++) {
        if (list[i].id === clipRef.id) { fresh = list[i]; break; }
      }
      renderDetail(fresh);
    });
  }

  function renderDetail(clip) {
    showView(detailView);

    var content = document.getElementById('detail-content');

    var pastedToHtml = '';
    if (clip.pastedTo && clip.pastedTo.length > 0) {
      pastedToHtml =
        '<div class="detail-section">' +
          '<div class="detail-label">Pasted To</div>' +
          clip.pastedTo.map(function(p) {
            return '<div class="paste-item">' +
              '<span>' + escapeHtml(p.hostname || p.title || p.url || 'Unknown') + '</span>' +
              '<span style="margin-left:auto;color:var(--text-muted)">' + timeAgo(p.timestamp) + '</span>' +
            '</div>';
          }).join('') +
        '</div>';
    }

    // Type-aware quick actions.
    var actionsHtml = buildTypeActions(clip);

    // Code clips get lightweight syntax highlighting; everything else is escaped
    // plain text.
    var contentHtml;
    if ((clip.type || 'text') === 'code') {
      contentHtml = '<div class="detail-text code-block">' + highlightCode(clip.text) + '</div>';
    } else {
      contentHtml = '<div class="detail-text">' + escapeHtml(clip.text) + '</div>';
    }

    content.innerHTML =
      (actionsHtml ? '<div class="detail-actions">' + actionsHtml + '</div>' : '') +

      '<div class="detail-section">' +
        '<div class="detail-label">Content</div>' +
        contentHtml +
      '</div>' +

      '<div class="detail-section">' +
        '<div class="detail-label">Copied From</div>' +
        '<div class="detail-link" id="open-source-btn">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>' +
          '<span>' + escapeHtml(clip.source || 'Unknown') + '</span>' +
        '</div>' +
        (clip.scrollY > 0 ? '<p style="font-size:10px;color:var(--text-muted);margin-top:6px">Scroll position saved — will return to exact spot</p>' : '') +
      '</div>' +

      '<div class="detail-section">' +
        '<div class="detail-label">Stats</div>' +
        '<div class="stat-row">' +
          '<div class="stat-card"><div class="stat-label">Times copied</div><div class="stat-value" style="font-size:16px">' + (clip.copyCount || 1) + '</div></div>' +
          '<div class="stat-card"><div class="stat-label">Times used</div><div class="stat-value" style="font-size:16px">' + (clip.pasteCount || 0) + '</div></div>' +
        '</div>' +
      '</div>' +

      pastedToHtml;

    var openBtn = document.getElementById('open-source-btn');
    if (openBtn && clip.source) {
      openBtn.addEventListener('click', function() {
        chrome.runtime.sendMessage({ type: 'OPEN_SOURCE', clip: clip }, function() {
          window.close();
        });
      });
    }

    wireTypeActions(clip);
  }

  // Build type-aware action buttons (open link, compose email, copy code, etc.).
  function buildTypeActions(clip) {
    var type = clip.type || 'text';
    var btns = [];
    var copyIcon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>';
    var linkIcon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>';
    var mailIcon = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"></path><polyline points="22,6 12,13 2,6"></polyline></svg>';

    btns.push('<button class="action-btn" data-act="copy">' + copyIcon + 'Copy</button>');
    if (type === 'url') {
      btns.push('<button class="action-btn" data-act="open-url">' + linkIcon + 'Open link</button>');
    } else if (type === 'email') {
      btns.push('<button class="action-btn" data-act="mailto">' + mailIcon + 'Compose email</button>');
    }
    return btns.join('');
  }

  function wireTypeActions(clip) {
    var container = document.querySelector('#detail-content .detail-actions');
    if (!container) return;
    container.querySelectorAll('.action-btn').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var act = btn.getAttribute('data-act');
        if (act === 'copy') {
          copyClip(clip);
        } else if (act === 'open-url') {
          var url = (clip.text || '').trim();
          chrome.tabs.create({ url: url }, function() {
            if (chrome.runtime.lastError) showToast('Could not open link');
            else window.close();
          });
        } else if (act === 'mailto') {
          var addr = (clip.text || '').trim();
          chrome.tabs.create({ url: 'mailto:' + addr }, function() {
            if (chrome.runtime.lastError) showToast('Could not open mail');
            else window.close();
          });
        }
      });
    });
  }

  // Fast HTML-text escape (quotes are safe inside element text).
  function escHtmlText(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Tiny, dependency-free code highlighter. Single-pass tokenizer so it never
  // re-scans its own injected markup. Monochrome-green palette (see CSS .tok-*).
  function highlightCode(src) {
    src = String(src || '');
    // Guard: don't tokenize enormous clips char-by-char.
    if (src.length > 8000) return escHtmlText(src);

    var patterns = [
      { cls: 'tok-com', re: /\/\*[\s\S]*?\*\/|\/\/[^\n]*|#[^\n]*/y },
      { cls: 'tok-str', re: /'[^'\n]*'|"[^"\n]*"|`[^`\n]*`/y },
      { cls: 'tok-kw',  re: /\b(?:const|let|var|function|return|if|else|for|while|class|import|export|from|new|await|async|def|public|private|static|void|int|string|bool|true|false|null|undefined|SELECT|INSERT|UPDATE|DELETE|FROM|WHERE)\b/y },
      { cls: 'tok-num', re: /\b\d+(?:\.\d+)?\b/y }
    ];

    var out = '';
    var plain = '';
    var i = 0;
    while (i < src.length) {
      var matched = false;
      for (var p = 0; p < patterns.length; p++) {
        patterns[p].re.lastIndex = i;
        var m = patterns[p].re.exec(src);
        if (m && m.index === i && m[0].length > 0) {
          if (plain) { out += escHtmlText(plain); plain = ''; }
          out += '<span class="' + patterns[p].cls + '">' + escHtmlText(m[0]) + '</span>';
          i += m[0].length;
          matched = true;
          break;
        }
      }
      if (!matched) {
        plain += src.charAt(i);
        i++;
      }
    }
    if (plain) out += escHtmlText(plain);
    return out;
  }

  // --- STATS VIEW ---
  function loadStatsData() {
    chrome.runtime.sendMessage({ type: 'GET_STATS' }, function(response) {
      if (chrome.runtime.lastError) {
        console.error('[MemClip] Stats error:', chrome.runtime.lastError);
        document.getElementById('stats-content').innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:40px 0">Error loading stats</p>';
        return;
      }
      var content = document.getElementById('stats-content');

      if (!response || !response.success) {
        content.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:40px 0">No data yet</p>';
        return;
      }

      var domainsHtml = '';
      if (response.topDomains && response.topDomains.length > 0) {
        domainsHtml = response.topDomains.map(function(d) {
          return '<div class="stat-list-item"><span>' + escapeHtml(d[0]) + '</span><span>' + d[1] + ' clips</span></div>';
        }).join('');
      } else {
        domainsHtml = '<div style="color:var(--text-muted);font-size:11px;padding:8px 0">No data yet</div>';
      }

      var destHtml = '';
      if (response.topPasteDestinations && response.topPasteDestinations.length > 0) {
        destHtml =
          '<div class="stat-card" style="margin-top:12px">' +
            '<div class="stat-list-title">Top Paste Destinations</div>' +
            response.topPasteDestinations.map(function(d) {
              return '<div class="stat-list-item"><span>' + escapeHtml(d[0]) + '</span><span>' + d[1] + ' pastes</span></div>';
            }).join('') +
          '</div>';
      }

      content.innerHTML =
        '<div class="stat-row">' +
          '<div class="stat-card"><div class="stat-label">Total Copies</div><div class="stat-value">' + (response.totalCopies || 0) + '</div></div>' +
          '<div class="stat-card"><div class="stat-label">Total Pastes</div><div class="stat-value">' + (response.totalPastes || 0) + '</div></div>' +
        '</div>' +
        '<div class="stat-card">' +
          '<div class="stat-list-title">Top Sources</div>' +
          domainsHtml +
        '</div>' +
        destHtml;
    });
  }

  // --- SETTINGS ---
  function loadSettingsData() {
    document.getElementById('total-clips').textContent = clips.length;
    chrome.storage.local.getBytesInUse(null, function(bytes) {
      if (chrome.runtime.lastError) {
        console.error('[MemClip] Storage bytes error:', chrome.runtime.lastError);
        document.getElementById('storage-used').textContent = '—';
      } else {
        var kb = (bytes / 1024).toFixed(1);
        document.getElementById('storage-used').textContent = kb + ' KB';
      }
    });

    chrome.storage.local.get([META_KEY], function(result) {
      if (chrome.runtime.lastError) {
        console.error('[MemClip] Meta read error:', chrome.runtime.lastError);
        return;
      }
      var meta = result[META_KEY] || {};
      var retentionDays = meta.retentionDays || DEFAULT_RETENTION_DAYS;
      var select = document.getElementById('retention-select');
      if (select) {
        select.value = retentionDays === 0 ? '0' : String(retentionDays);
      }
    });

    chrome.storage.local.get([SETTINGS_KEY], function(result) {
      if (chrome.runtime.lastError) {
        console.error('[MemClip] settings read error:', chrome.runtime.lastError);
        return;
      }
      var s = result[SETTINGS_KEY] || {};
      setChecked('set-ignore-sensitive', s.ignoreSensitive !== false);
      setChecked('set-skip-password', s.skipPasswordFields !== false);
      setChecked('set-capture-incognito', s.captureIncognito === true);
      var dl = document.getElementById('set-denylist');
      if (dl) dl.value = Array.isArray(s.denylist) ? s.denylist.join('\n') : '';
    });
  }

  function setChecked(id, val) {
    var el = document.getElementById(id);
    if (el) el.checked = !!val;
  }

  function onRetentionChange() {
    var select = document.getElementById('retention-select');
    if (!select) return;
    var days = parseInt(select.value, 10);
    if (isNaN(days) || days < 0) days = 30;

    chrome.storage.local.get([META_KEY], function(result) {
      if (chrome.runtime.lastError) {
        console.error('[MemClip] Meta read error:', chrome.runtime.lastError);
        return;
      }
      var meta = result[META_KEY] || {};
      meta.retentionDays = days;
      chrome.storage.local.set({ [META_KEY]: meta }, function() {
        if (chrome.runtime.lastError) {
          console.error('[MemClip] Meta write error:', chrome.runtime.lastError);
          showToast('Error saving retention');
        } else {
          showToast('Retention updated');
          // Trigger purge in background
          chrome.runtime.sendMessage({ type: 'PURGE_OLD_CLIPS' }, function(response) {
            if (chrome.runtime.lastError) {
              console.error('[MemClip] Purge send error:', chrome.runtime.lastError);
            }
          });
        }
      });
    });
  }

  // --- COPY ---
  function copyClip(clip) {
    navigator.clipboard.writeText(clip.text).then(function() {
      showToast('Copied');
    }).catch(function() {
      var textarea = document.createElement('textarea');
      textarea.value = clip.text;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      showToast('Copied');
    });
  }

  // --- SELECTION ---
  function updateSelection() {
    var items = clipsList.querySelectorAll('.clip-item');
    items.forEach(function(item, i) {
      if (i === selectedIndex) {
        item.classList.add('selected');
        item.scrollIntoView({ block: 'nearest' });
      } else {
        item.classList.remove('selected');
      }
    });
  }

  // --- TOAST ---
  function showToast(msg) {
    toastText.textContent = msg;
    toast.classList.add('show');
    setTimeout(function() {
      toast.classList.remove('show');
    }, 1500);
  }

  // --- HELPERS ---
  function sortClips(a, b) {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    if (a.pinned && b.pinned) {
      var ar = typeof a.pinRank === 'number' ? a.pinRank : null;
      var br = typeof b.pinRank === 'number' ? b.pinRank : null;
      if (ar !== null && br !== null && ar !== br) return ar - br;
      if (ar !== null && br === null) return -1;
      if (ar === null && br !== null) return 1;
    }
    return (b.timestamp || 0) - (a.timestamp || 0);
  }

  // Subsequence fuzzy match: returns a score (>0 match) rewarding contiguous
  // runs and early matches; 0 means no match.
  function fuzzyScore(needle, hay) {
    if (!hay) return 0;
    hay = hay.toLowerCase();
    var hi = 0, ni = 0, score = 0, streak = 0;
    for (; ni < needle.length && hi < hay.length; hi++) {
      if (hay.charAt(hi) === needle.charAt(ni)) {
        streak++;
        score += 1 + streak;            // contiguous matches worth more
        if (hi === 0) score += 3;       // match at start
        ni++;
      } else {
        streak = 0;
      }
    }
    return ni === needle.length ? score : 0;
  }

  // Combined relevance score for a clip against a query.
  function scoreClip(clip, q) {
    var text = (clip.text || '').toLowerCase();
    var host = (clip.hostname || '').toLowerCase();
    var title = (clip.pageTitle || '').toLowerCase();

    // Strong boosts for direct substring hits.
    var score = 0;
    if (text.indexOf(q) !== -1) score += 100 + (text.indexOf(q) === 0 ? 25 : 0);
    if (host.indexOf(q) !== -1) score += 60;
    if (title.indexOf(q) !== -1) score += 40;
    if (score > 0) return score;

    // Fall back to fuzzy subsequence across the fields.
    var f = Math.max(fuzzyScore(q, text), fuzzyScore(q, host) + 2, fuzzyScore(q, title));
    return f;
  }

  function timeAgo(ts) {
    var diff = Math.floor((Date.now() - ts) / 1000);
    if (diff < 60) return 'Just now';
    var m = Math.floor(diff / 60);
    if (m < 60) return m + 'm ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    var d = Math.floor(h / 24);
    if (d < 7) return d + 'd ago';
    return new Date(ts).toLocaleDateString();
  }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text || '';
    return div.innerHTML;
  }

  // --- INIT ---
  if (DEBUG) console.log('[MemClip][popup] initializing');
  if (DEBUG) console.log('[MemClip][popup] ensureMeta done, calling init');
  loadClips();
  searchInput.focus();
  if (DEBUG) console.log('[MemClip][popup] init complete');

  }

});
