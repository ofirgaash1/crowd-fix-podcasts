// v2/main.js
// App bootstrap + modeless editing coordinator (diff + align workers).

import { store, getState, makeThrottle } from './core/state.js';
import { ScrollVirtualizer } from './render/virtualizer.js';
import { renderDiffHTML } from './render/diff-panel.js';
import { setupPlayerSync } from './player/sync.js'; // <-- ADD
import { listFolders, listFiles, loadEpisode, hasCorrection } from './data/api.js';

/* =========================================================================
   Debounce helper (leading/trailing aware)
   ========================================================================= */
function makeDebounce(fn, wait = 150) {
  let t = 0, pendingLeading = false;
  const debounced = (ms, leading = false) => {
    const delay = (typeof ms === 'number') ? ms : wait;
    if (leading && !pendingLeading) {
      pendingLeading = true;
      fn().finally(() => { pendingLeading = false; });
      return;
    }
    clearTimeout(t);
    t = setTimeout(fn, delay);
  };
  return debounced;
}

/* =========================================================================
   DOM
   ========================================================================= */
const els = {
  transcript: document.getElementById('transcript'),
  diffBody:   document.getElementById('diffBody'),
  probToggle: document.getElementById('probToggle'),
  player:     document.getElementById('player'),
  folders:    document.getElementById('folders'),
  files:      document.getElementById('files'),
  settingsBtn: document.getElementById('settingsBtn'),
  modal:      document.getElementById('modal'),
  hfToken:    document.getElementById('hfToken'),
  mSave:      document.getElementById('mSave'),
  mClear:     document.getElementById('mClear'),
  mClose:     document.getElementById('mClose'),
  themeToggle: document.getElementById('themeToggle'),
  themeIcon:  document.getElementById('themeIcon'),
};

/* =========================================================================
   Workers
   ========================================================================= */
function initWorkers() {
  // diff worker
  const diffW  = new Worker('./v2/workers/diff-worker.js',  { type: 'module' });
  // align worker
  const alignW = new Worker('./v2/workers/align-worker.js', { type: 'module' });

  let msgId = 1;
  const pending = new Map(); // id -> { resolve, reject, kind }
  let diffReady = false;
  let alignReady = false;

  // Initialize workers with baseline
  try {
    console.log('Initializing diff worker...');
    diffW.postMessage({ type: 'init', baselineText: '' });
    console.log('Initializing align worker...');
    alignW.postMessage({ type: 'init', baselineTokens: [] });
  } catch (err) {
    console.error('Worker initialization failed:', err);
  }

  function handleMessage(ev, kind) {
    const { id, type } = ev.data || {};
    
    // Handle initialization responses
    if (type === `${kind}:ready`) {
      console.log(`${kind} worker ready`);
      if (kind === 'diff') diffReady = true;
      else if (kind === 'align') alignReady = true;
      return;
    }
    
    if (!id || !pending.has(id)) return;
    const entry = pending.get(id);
    if (entry.kind !== kind) return;
    const { resolve, reject } = entry;
    pending.delete(id);

    if (type === `${kind}:result`) resolve(ev.data);
    else if (type === `${kind}:error`) reject(new Error(ev.data.message || `${kind} worker error`));
  }

  diffW.onmessage  = (ev) => handleMessage(ev, 'diff');
  alignW.onmessage = (ev) => handleMessage(ev, 'align');

  diffW.onerror  = (err) => { 
    console.error('Diff worker error:', err); 
    console.error('Diff worker error details:', err.error || err.message || err);
    const e = new Error('Diff worker crashed');  
    for (const v of pending.values()) if (v.kind==='diff')  v.reject(e); 
  };
  alignW.onerror = (err) => { 
    console.error('Align worker error:', err); 
    console.error('Align worker error details:', err.error || err.message || err);
    const e = new Error('Align worker crashed'); 
    for (const v of pending.values()) if (v.kind==='align') v.reject(e); 
  };

  const sendDiff = (base, current, options) => {
    if (!diffReady) {
      return Promise.reject(new Error('Diff worker not ready'));
    }
    const id = msgId++;
    const payload = { id, type: 'diff', text: current, options };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, kind: 'diff' });
      diffW.postMessage(payload);
    });
  };

  const setDiffBaseline = (baselineText) => {
    diffW.postMessage({ type: 'setBaseline', baselineText });
  };

  const setAlignBaseline = (baselineTokens) => {
    alignW.postMessage({ type: 'setBaseline', baselineTokens });
  };

  const sendAlign = (baselineTokens, currentText) => {
    if (!alignReady) {
      return Promise.reject(new Error('Align worker not ready'));
    }
    const id = msgId++;
    const payload = { id, type: 'align', text: currentText };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, kind: 'align' });
      alignW.postMessage(payload);
    });
  };

  const terminateAll = () => {
    try { diffW.terminate(); } catch {}
    try { alignW.terminate(); } catch {}
    for (const { reject } of pending.values()) reject(new Error('Workers terminated'));
    pending.clear();
  };

  return {
    diff:  { send: sendDiff, setBaseline: setDiffBaseline },
    align: { send: sendAlign, setBaseline: setAlignBaseline },
    terminateAll,
    isReady: () => diffReady && alignReady,
    diffReady: () => diffReady,
    alignReady: () => alignReady,
  };
}

/* =========================================================================
   Caret helpers for contentEditable
   ========================================================================= */
function plainText(node) {
  // innerText keeps user-facing line breaks; normalize CR
  return (node?.innerText || '').replace(/\r/g, '');
}

function getSelectionOffsets(container) {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const r = sel.getRangeAt(0);
  const inC = n => n && (n === container || container.contains(n));
  if (!(inC(r.startContainer) && inC(r.endContainer))) return null;

  const measure = (node, off) => {
    const rng = document.createRange();
    rng.selectNodeContents(container);
    try { rng.setEnd(node, off); } catch { return 0; }
    return rng.toString().length;
  };
  const s = measure(r.startContainer, r.startOffset);
  const e = measure(r.endContainer, r.endOffset);
  return [Math.min(s, e), Math.max(s, e)];
}

function setSelectionByOffsets(container, start, end) {
  const text = plainText(container);
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const S = clamp(start || 0, 0, text.length);
  const E = clamp((end == null ? S : end), 0, text.length);

  const tw = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null);
  let pos = 0, n, sNode = container, sOff = 0, eNode = container, eOff = 0;
  while ((n = tw.nextNode())) {
    const len = n.nodeValue.length;
    if (pos + len >= S && sNode === container) { sNode = n; sOff = S - pos; }
    if (pos + len >= E) { eNode = n; eOff = E - pos; break; }
    pos += len;
  }
  const sel = window.getSelection();
  const rng = document.createRange();
  try { rng.setStart(sNode, sOff); rng.setEnd(eNode, eOff); } catch { return; }
  sel.removeAllRanges(); sel.addRange(rng);
  container.focus();
}

/* =========================================================================
   Editing coordinator: diff (fast) + align (heavy) with IME guard
   ========================================================================= */
function setupEditorPipeline({ workers, virtualizer }) {
  if (!els.transcript) throw new Error('#transcript missing');

  // Ensure modeless editing on the same node the virtualizer paints into.
  els.transcript.contentEditable = 'true';
  els.transcript.spellcheck = false;
  els.transcript.setAttribute('dir', 'auto');

  // IME guard
  let composing = false;
  els.transcript.addEventListener('compositionstart', () => { composing = true; });
  els.transcript.addEventListener('compositionend', () => {
    composing = false;
    // Flush immediately after IME finishes.
    scheduleDiffSync(0, /*leading*/true);
    scheduleAlignSync(0, /*leading*/true);
  });

  // Live text → store
  const pushLiveText = () => {
    const txt = plainText(els.transcript);
    store.setLiveText(txt);
  };

  // Diff: debounce ~150ms
  let diffRetryCount = 0;
  const maxDiffRetries = 10;
  
  const scheduleDiffSync = makeDebounce(async () => {
    const st = getState();
    if (!st.baselineText) { renderDiffHTML(els.diffBody, []); return; }
    
    // Check if diff worker is ready
    if (!workers.diffReady()) {
      if (diffRetryCount < maxDiffRetries) {
        diffRetryCount++;
        console.warn(`Diff worker not ready, retrying in 100ms (${diffRetryCount}/${maxDiffRetries})`);
        setTimeout(() => scheduleDiffSync(), 100);
      } else {
        console.error('Diff worker failed to become ready after maximum retries');
        diffRetryCount = 0; // Reset for next time
      }
      return;
    }
    
    // Reset retry count on success
    diffRetryCount = 0;
    
    // Update baseline if it changed
    workers.diff.setBaseline(st.baselineText);
    
    try {
      const { diffs } = await workers.diff.send(st.baselineText, st.liveText, { timeoutSec: 0.8, editCost: 8 });
      renderDiffHTML(els.diffBody, diffs);
    } catch (err) {
      // Keep UI responsive; show nothing on error
      console.warn('diff failed:', err?.message || err);
    }
  }, 150);

  // Align: throttle to at most once / 1000ms (user asked for ≤1 Hz heavy work)
  let alignRetryCount = 0;
  const maxAlignRetries = 10;
  
  const scheduleAlignSync = makeThrottle(async () => {
    const st = getState();
    if (!Array.isArray(st.baselineTokens) || !st.baselineTokens.length) return;

    // Check if align worker is ready
    if (!workers.alignReady()) {
      if (alignRetryCount < maxAlignRetries) {
        alignRetryCount++;
        console.warn(`Align worker not ready, retrying in 100ms (${alignRetryCount}/${maxAlignRetries})`);
        setTimeout(() => scheduleAlignSync(), 100);
      } else {
        console.error('Align worker failed to become ready after maximum retries');
        alignRetryCount = 0; // Reset for next time
      }
      return;
    }
    
    // Reset retry count on success
    alignRetryCount = 0;

    // Preserve caret across DOM rebuild
    const sel = getSelectionOffsets(els.transcript);

    // Update baseline if it changed
    workers.align.setBaseline(st.baselineTokens);

    try {
      const { tokens } = await workers.align.send(st.baselineTokens, st.liveText);
      // Feed tokens back into store → virtualizer subscription will rebuild spans incrementally
      store.setTokens(tokens);
    } catch (err) {
      console.warn('align failed:', err?.message || err);
    } finally {
      // Attempt to restore caret (best-effort)
      if (sel) setSelectionByOffsets(els.transcript, sel[0], sel[1]);
    }
  }, 1000);

  // Input pipeline
  els.transcript.addEventListener('input', () => {
    if (composing) return; // IME - wait for compositionend
    pushLiveText();
    scheduleDiffSync();
    scheduleAlignSync();
  });

  // First paint from initial state (if any)
  pushLiveText();
  
  // Wait for workers to be ready before initial sync
  let workerWaitAttempts = 0;
  const maxWorkerWaitAttempts = 50; // 5 seconds max wait
  
  const waitForWorkers = () => {
    if (workers.isReady()) {
      console.log('All workers ready, running initial sync');
      scheduleDiffSync(0, true);
      scheduleAlignSync(0, true);
    } else if (workerWaitAttempts < maxWorkerWaitAttempts) {
      workerWaitAttempts++;
      console.log(`Waiting for workers... attempt ${workerWaitAttempts}/${maxWorkerWaitAttempts}`);
      // Retry after a short delay
      setTimeout(waitForWorkers, 100);
    } else {
      console.error('Workers failed to initialize within timeout');
    }
  };
  waitForWorkers();

  // Karaoke seek (click word)
  els.transcript.addEventListener('click', (e) => {
    const span = e.target.closest('span.word');
    if (!span) return;
    const t = parseFloat(span.dataset.start);
    if (!Number.isFinite(t)) return;
    els.transcript.dispatchEvent(new CustomEvent('v2:seek', { detail: { time: t } }));
  }, { passive: true });


  // Probability toggle
  if (els.probToggle) {
    const applyBtnUI = () => {
      const on = !!getState().settings?.probEnabled;
      els.probToggle.setAttribute('aria-pressed', String(on));
      els.probToggle.textContent = on ? 'בטל הדגשה' : 'הדגש ודאות נמוכה';
    };
    // init from localStorage (handled in store ctor) → just paint button and view
    applyBtnUI();

    els.probToggle.addEventListener('click', () => {
      const on = !getState().settings?.probEnabled;
      store.setProbEnabled(on);       // triggers virtualizer repaint via subscription
      try { localStorage.setItem('probHL', on ? 'on' : 'off'); } catch {}
      applyBtnUI();
    });
  }
}

/* =========================================================================
   Browser functionality
   ========================================================================= */
function setupBrowser() {
  if (!els.folders || !els.files) return;

  let currentFolder = null;
  let currentFile = null;
  let lastLoadController = null;

  // Populate folders list
  async function loadFolders() {
    try {
      els.folders.innerHTML = '<div class="item">טוען...</div>';
      const folders = await listFolders();
      
      if (folders.length === 0) {
        els.folders.innerHTML = '<div class="item">אין תיקיות</div>';
        return;
      }

      els.folders.innerHTML = folders.map(folder => 
        `<div class="item" data-folder="${folder.name}">📁 ${folder.name}</div>`
      ).join('');

      // Add click handlers
      els.folders.querySelectorAll('.item').forEach(item => {
        item.addEventListener('click', () => {
          els.folders.querySelectorAll('.item').forEach(i => i.classList.remove('active'));
          item.classList.add('active');
          loadFiles(item.dataset.folder);
        });
      });

      // Auto-select first folder
      const firstFolder = els.folders.querySelector('.item');
      if (firstFolder) {
        firstFolder.click();
      }
    } catch (error) {
      console.error('Failed to load folders:', error);
      els.folders.innerHTML = '<div class="item error">שגיאה בטעינת תיקיות</div>';
    }
  }

  // Populate files list
  async function loadFiles(folderName) {
    if (!folderName) return;
    
    currentFolder = folderName;
    currentFile = null;
    
    try {
      els.files.innerHTML = '<div class="item">טוען...</div>';
      const files = await listFiles(folderName);
      
      if (files.length === 0) {
        els.files.innerHTML = '<div class="item">אין קבצים</div>';
        return;
      }

      els.files.innerHTML = files.map(file => {
        const display = file.name.replace(/\.opus$/i, '');
        const hasCorr = hasCorrection(`${folderName}/${file.name}`);
        const correctionClass = hasCorr ? 'has-correction' : 'no-correction';
        return `<div class="item ${correctionClass}" data-file="${file.name}">🎵 ${display}</div>`;
      }).join('');

      // Add click handlers
      els.files.querySelectorAll('.item').forEach(item => {
        item.addEventListener('click', () => {
          els.files.querySelectorAll('.item').forEach(i => i.classList.remove('active'));
          item.classList.add('active');
          loadEpisodeFile(folderName, item.dataset.file);
        });
      });
    } catch (error) {
      console.error('Failed to load files:', error);
      els.files.innerHTML = '<div class="item error">שגיאה בטעינת קבצים</div>';
    }
  }

  // Load episode when file is selected
  async function loadEpisodeFile(folder, file) {
    if (!folder || !file) return;
    
    currentFile = file;
    
    // Abort previous load
    if (lastLoadController) {
      lastLoadController.abort();
    }
    
    // Create new abort controller
    const controller = new AbortController();
    lastLoadController = controller;
    
    // Show loading state
    const errEl = document.getElementById('err');
    if (errEl) errEl.textContent = 'טוען פרק...';
    
    // Add loading class to current file item
    const fileItem = els.files.querySelector(`[data-file="${file}"]`);
    if (fileItem) fileItem.classList.add('loading');
    
    try {
      const episode = await loadEpisode({ folder, file });
      
      // Check if this load was aborted
      if (controller.signal.aborted) return;
      
      // Update audio player
      if (els.player) {
        els.player.src = episode.audioUrl;
        els.player.load();
      }
      
      // Update store with baseline data
      store.setBaseline({
        text: episode.baselineText,
        tokens: episode.baselineTokens
      });
      
      // Set initial tokens
      store.setTokens(episode.initialTokens);
      
      // Clear error message
      if (errEl) errEl.textContent = '';
      
      console.log(`Loaded episode: ${folder}/${file}`);
    } catch (error) {
      if (error.name === 'AbortError') {
        console.log('Episode load aborted');
        return;
      }
      console.error('Failed to load episode:', error);
      const errEl = document.getElementById('err');
      if (errEl) errEl.textContent = `שגיאה בטעינת פרק: ${error.message}`;
    } finally {
      // Remove loading class
      if (fileItem) fileItem.classList.remove('loading');
    }
  }

  // Initialize browser
  loadFolders();
}

/* =========================================================================
   Settings Modal
   ========================================================================= */
function setupSettingsModal() {
  if (!els.settingsBtn || !els.modal) return;

  // Load current token on modal open
  function loadCurrentToken() {
    try {
      const token = localStorage.getItem('hfToken') || '';
      els.hfToken.value = token;
    } catch (e) {
      console.warn('Failed to load token from localStorage:', e);
    }
  }

  // Save token to localStorage and update button text
  function saveToken() {
    try {
      const token = els.hfToken.value.trim();
      localStorage.setItem('hfToken', token);
      
      // Update button text based on token presence
      updateSettingsButtonText();
      
      // Reload browser to refresh corrections cache if Supabase is configured
      if (window.location.reload) {
        // Small delay to ensure localStorage is updated
        setTimeout(() => {
          window.location.reload();
        }, 100);
      }
    } catch (e) {
      console.error('Failed to save token:', e);
      alert('שגיאה בשמירת הטוקן');
    }
  }

  // Clear token
  function clearToken() {
    els.hfToken.value = '';
    try {
      localStorage.removeItem('hfToken');
      updateSettingsButtonText();
    } catch (e) {
      console.warn('Failed to clear token:', e);
    }
  }

  // Update settings button text based on token presence
  function updateSettingsButtonText() {
    try {
      const hasToken = !!localStorage.getItem('hfToken');
      els.settingsBtn.textContent = hasToken ? '⚙️ הגדרות' : '⚙️ צדיק, הזנת טוקן?';
    } catch (e) {
      console.warn('Failed to update settings button text:', e);
    }
  }

  // Open modal
  function openModal() {
    loadCurrentToken();
    els.modal.classList.add('open');
    els.hfToken.focus();
  }

  // Close modal
  function closeModal() {
    els.modal.classList.remove('open');
    els.settingsBtn.focus();
  }

  // Event listeners
  els.settingsBtn.addEventListener('click', openModal);
  els.mSave.addEventListener('click', () => {
    saveToken();
    closeModal();
  });
  els.mClear.addEventListener('click', clearToken);
  els.mClose.addEventListener('click', closeModal);

  // Close modal on backdrop click
  els.modal.addEventListener('click', (e) => {
    if (e.target === els.modal) {
      closeModal();
    }
  });

  // Close modal on Escape key
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && els.modal.classList.contains('open')) {
      closeModal();
    }
  });

  // Initialize button text
  updateSettingsButtonText();
}

/* =========================================================================
   Theme Toggle
   ========================================================================= */
function setupThemeToggle() {
  if (!els.themeToggle || !els.themeIcon) return;

  // Get current theme from localStorage or default to 'light'
  function getCurrentTheme() {
    try {
      return localStorage.getItem('theme') || 'light';
    } catch (e) {
      return 'light';
    }
  }

  // Save theme to localStorage
  function saveTheme(theme) {
    try {
      localStorage.setItem('theme', theme);
    } catch (e) {
      console.warn('Failed to save theme to localStorage:', e);
    }
  }

  // Apply theme to document
  function applyTheme(theme) {
    const html = document.documentElement;
    
    if (theme === 'dark') {
      html.classList.add('theme-dark');
      html.classList.remove('theme-light');
    } else {
      html.classList.add('theme-light');
      html.classList.remove('theme-dark');
    }
  }

  // Update button icon
  function updateThemeIcon(theme) {
    els.themeIcon.textContent = theme === 'dark' ? '☀️' : '🌙';
  }

  // Toggle theme
  function toggleTheme() {
    const currentTheme = getCurrentTheme();
    const newTheme = currentTheme === 'dark' ? 'light' : 'dark';
    
    applyTheme(newTheme);
    saveTheme(newTheme);
    updateThemeIcon(newTheme);
  }

  // Initialize theme on page load
  function initializeTheme() {
    const savedTheme = getCurrentTheme();
    applyTheme(savedTheme);
    updateThemeIcon(savedTheme);
  }

  // Event listener
  els.themeToggle.addEventListener('click', toggleTheme);

  // Initialize theme
  initializeTheme();
}

/* =========================================================================
   Boot
   ========================================================================= */
const workers = initWorkers();

// Virtualized transcript view subscribes to store and paints tokens.
const virtualizer = new ScrollVirtualizer({ container: els.transcript });

// Subscribe to store updates
store.subscribe((state, tag) => {
  if (tag === 'tokens' || tag === 'baseline') {
    const tokens = state.tokens && state.tokens.length ? state.tokens : 
                   (state.baselineTokens && state.baselineTokens.length ? state.baselineTokens : []);
    virtualizer.setTokens(tokens);
  }
  if (tag === 'settings:probEnabled') {
    virtualizer.setProbEnabled(!!state.settings?.probEnabled);
  }
  if (tag === 'settings:probThreshold') {
    virtualizer.setProbThreshold(state.settings?.probThreshold);
  }
  if (tag === 'confirmedRanges') {
    virtualizer.setConfirmedRanges(state.confirmedRanges);
  }
});

// Player sync: keeps store.playback in sync + handles CustomEvent('v2:seek')
let playerCtrl = null;
if (els.player) {
  playerCtrl = setupPlayerSync(els.player, {
    seekTarget: els.transcript, // listens for v2:seek from the transcript
    playOnSeek: false,          // keep your current UX: seek without auto-play
    publishHz: 60               // cap publish rate
  });
}

// Initial state will be handled by the store subscription above


// Editing pipeline (modeless)
setupEditorPipeline({ workers, virtualizer });

// Initialize browser (folder/file listing)
setupBrowser();

// Initialize settings modal
setupSettingsModal();

// Initialize theme toggle
setupThemeToggle();
