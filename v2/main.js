// v2/main.js
// App bootstrap + modeless editing coordinator (diff + align workers).

import { store, getState, makeThrottle } from './core/state.js';
import { ScrollVirtualizer } from './render/virtualizer.js';
import { setupPlayerSync } from './player/sync.js';
import { setupBrowser } from './data/browser.js';
import { search as searchApi, fetchSegments as fetchSegApi, resultToEpisode } from './data/search.js';
import { setupWordsPager } from './data/words-pager.js';
import { setupShowLayers, refreshLayers } from './history/show-layers.js';
import { setupScrollSync, setupGutters } from './ui/layout.js';
import { setupKaraokeFollow } from './player/karaoke.js';
import { setupThemeToggle } from './ui/theme.js';
import { setupUIControls } from './ui/controls.js';
import { showToast } from './ui/toast.js';
import { setupMergeModal } from './ui/merge-modal.js';
import { setupHud } from './ui/hud.js';
import { setupHistoryPanel } from './history/panel.js';
import { setupEditorPipeline as setupEditorPipelineMod, setShowingLayers as setLayersFlag, getTypingQuietUntil, setTypingQuiet as setTypingQuiet } from './editor/pipeline.js';
import { initWorkers } from './workers/init.js';

// makeDebounce and caret helpers now live in editor/pipeline.js and UI modules.

/* =========================================================================
   DOM
   ========================================================================= */
const els = {
  transcript: document.getElementById('transcript'),
  diffBody: document.getElementById('diffBody'),
  probToggle: document.getElementById('probToggle'),
  player: document.getElementById('player'),
  folders: document.getElementById('folders'),
  files: document.getElementById('files'),
  // settings modal removed
  themeToggle: document.getElementById('themeToggle'),
  themeIcon: document.getElementById('themeIcon'),
  // Added controls
  submitBtn: document.getElementById('submitBtn'),
  fontMinus: document.getElementById('fontMinus'),
  fontPlus: document.getElementById('fontPlus'),
  markReliable: document.getElementById('markReliable'),
  markUnreliable: document.getElementById('markUnreliable'),
  scrollTopBtn: document.getElementById('scrollTopBtn'),
  dlVtt: document.getElementById('dlVtt'),
  rate: document.getElementById('rate'),
  rateVal: document.getElementById('rateVal'),
  // Layout & gutters
  panel: document.getElementById('panel'),
  gutterL: document.getElementById('gutterL'),
  gutterR: document.getElementById('gutterR'),
  browserCard: document.getElementById('browserCard'),
  diffCard: document.getElementById('diffCard'),
  transcriptCard: document.getElementById('transcriptCard'),
  showLayersBtn: document.getElementById('showLayersBtn'),
  // Merge modal elements
  mergeModal: document.getElementById('mergeModal'),
  mergeReload: document.getElementById('mergeReload'),
  mergeTry: document.getElementById('mergeTry'),
  mergeClose: document.getElementById('mergeClose'),
  diffParentLatest: document.getElementById('diffParentLatest'),
  diffParentClient: document.getElementById('diffParentClient'),
};

// Global edit generation: increments on input/IME end or document switch
let editGen = 0;
// Typing quiet window and pending counters
let typingQuietUntil = 0;
const pending = { diff: 0, align: 0 };
const nowMs = () => performance.now();
const isIdle = () => (nowMs() >= typingQuietUntil) && (pending.diff + pending.align === 0);

// LocalStorage keys for gutters
const LS_W_NAV = 'v2:w:nav';
const LS_W_DIFF = 'v2:w:diff';

// When true, the diff pane shows layers view and diff renderer should pause
let showingLayers = false;


/* =========================================================================
   Workers
   ========================================================================= */
// Workers init moved to workers/init.js

/* =========================================================================
   Caret helpers for contentEditable
   ========================================================================= */
// Selection helpers are provided by editor/pipeline.js implementation.

/* Editing pipeline is handled by ./editor/pipeline.js */


// Browser (folder/file listing) handled by ./data/browser.js
/* =========================================================================
   Boot
   ========================================================================= */
const workers = initWorkers();

// Virtualized transcript view subscribes to store and paints tokens.
const virtualizer = new ScrollVirtualizer({
  container: els.transcript,
  // Scroll actually occurs on the card body wrapper
  scrollEl: els.transcriptCard ? els.transcriptCard.querySelector('.body') : els.transcript
});
// Initialize renderer settings from store
try {
  const s0 = getState();
  virtualizer.setProbEnabled(!!s0.settings?.probEnabled);
  if (typeof s0.settings?.probThreshold === 'number') {
    virtualizer.setProbThreshold(s0.settings.probThreshold);
  }
} catch { }

// Version/hash badge updater
function updateVersionBadge() {
  const badge = document.getElementById('versionBadge');
  if (!badge) return;
  const st = getState();
  const v = st.version || 0;
  const h = (st.base_sha256 || '').slice(0, 8);
  if (v > 0 && h) badge.textContent = `גרסה ${v} • ${h}`;
  else badge.textContent = '';
}

// Dev metrics HUD now modular
const { metrics } = setupHud(virtualizer);

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
  if (tag === 'version:init' || tag === 'version:clear' || tag === 'version:saved') {
    updateVersionBadge();
    try { refreshLayers(els, workers); } catch {}
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
  try {
    els.player.addEventListener('error', () => {
      const err = els.player.error; const code = err ? err.code : 0;
      console.warn('Audio element error', { code, src: els.player.currentSrc || els.player.src });
    });
  } catch {}
}

// Initial state will be handled by the store subscription above


// Editing pipeline (modeless)
const editGenRef = { value: editGen };
const getDocKey = () => `${els.transcript?.dataset.folder || ''}/${els.transcript?.dataset.file || ''}`;
const setTypingQuietUntil = (ts) => { typingQuietUntil = ts; setTypingQuiet(ts); };
const isIdleFn = () => (nowMs() >= typingQuietUntil) && (pending.diff + pending.align === 0);
function setupEditorPipelineAdapter() {
  setupEditorPipelineMod(els, {
    workers,
    virtualizer,
    getDocKey,
    editGenRef,
    setTypingQuietUntil,
    isIdle: isIdleFn,
    nowMs
  });
}
setupEditorPipelineAdapter();

// Initialize browser (folder/file listing)
setupBrowser(els, { bumpEditGen: () => { editGen++; } });

// Initialize merge modal
const mergeModal = setupMergeModal(els);


// Initialize theme toggle
setupThemeToggle(els);

// Wire UI controls (rate, VTT, font, confirm, back-to-top)
setupUIControls(els, { workers, mergeModal }, virtualizer, playerCtrl, isIdle);

// History sidebar
setupHistoryPanel(els, workers);

// Gutters and scroll sync
setupGutters(els);
setupScrollSync(els);

// Karaoke follow (highlight + gentle auto-scroll)
setupKaraokeFollow(els, virtualizer);

// Global unauthorized handler (401 → toast + redirect)
try {
  window.addEventListener('v2:unauthorized', (e) => {
    try { showToast('יש להתחבר', 'error'); } catch {}
  });
} catch {}

// Dev: worst-case load generator for virtualizer performance testing
try {
  window.__loadWorstCase = (n = 200000) => {
    const count = Math.max(1, Math.min(1000000, parseInt(n, 10) || 200000));
    const toks = new Array(count);
    for (let i = 0; i < count; i++) {
      // alternate characters and line breaks sparsely
      if ((i % 1019) === 1018) toks[i] = { word: '\n', start: 0, end: 0 };
      else toks[i] = { word: 'א', start: 0, end: 0, probability: Math.random() < 0.1 ? 0.7 : 0.99 };
    }
    store.setTokens(toks);
    const text = toks.map(t => t.word).join('');
    store.setLiveText(text);
    store.setBaseline({ text, tokens: toks });
    console.log(`Loaded worst-case tokens: ${count}`);
    return { count };
  };
} catch {}

// Dev: expose a diff helper in console
try {
  // Lazy-load core so normal usage isn’t affected
  window.__diff = async (a, b) => {
    const { diffStrings, reconstructNew, reconstructOld } = await import('./workers/diff-core.js');
    const diffs = diffStrings(String(a || ''), String(b || ''));
    const newText = reconstructNew(diffs);
    const oldText = reconstructOld(diffs);
    console.log('diffs:', diffs);
    console.log('reconstruct new ok:', newText === String(b || ''));
    console.log('reconstruct old ok:', oldText === String(a || ''));
    return diffs;
  };
} catch {}

/* transcript interactions */
// Alt+click a word to seek/play from its start (keeps normal click for editing)
if (els.transcript && els.player) {
  let pendingSeek = null;
  const safeSeekPlay = (sec, autoPlay = true) => {
    const p = els.player;
    if (!p) return;
    // Require a selected episode (src set) before trying to play
    const hasSrc = !!p.currentSrc || !!p.src;
    if (!hasSrc) { try { console.warn('Audio not ready: no source on <audio>'); } catch {} return; }
    const seekTo = Math.max(0, (+sec || 0) + 0.01);
    const doSeek = () => {
      try {
        // Prefer central player controller if available
        if (playerCtrl && typeof playerCtrl.seekTo === 'function') playerCtrl.seekTo(seekTo);
        else p.currentTime = seekTo;
      } catch {}
    };
    const doPlay = () => {
      if (!autoPlay) return;
      try {
        const pr = p.play(); if (pr && typeof pr.catch === 'function') pr.catch(()=>{});
      } catch {}
    };
    if (p.readyState < 1) {
      // Wait for metadata but do NOT call load() here (can reset to 0)
      pendingSeek = seekTo;
      const onMeta = () => { try { p.removeEventListener('loadedmetadata', onMeta); } catch {}; if (pendingSeek != null) { doSeek(); doPlay(); pendingSeek = null; } };
      try { p.addEventListener('loadedmetadata', onMeta, { once: true }); } catch {}
      return;
    }
    doSeek();
    if (p.readyState < 2) {
      const onPlay = () => { try { p.removeEventListener('canplay', onPlay); } catch {}; doPlay(); };
      try { p.addEventListener('canplay', onPlay, { once: true }); } catch {}
      return;
    }
    doPlay();
  };

  els.transcript.addEventListener('click', (e) => {
    if (!e.altKey) return;
    const el = e.target && e.target.closest ? e.target.closest('.word') : null;
    if (!el) return;
    const t = +el.dataset.start;
    if (Number.isFinite(t)) { safeSeekPlay(t, true); e.preventDefault(); try { e.stopPropagation(); } catch {} }
  });

  // Right-click a word to seek/play and suppress the context menu
  els.transcript.addEventListener('contextmenu', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('.word') : null;
    if (!el) return;
    const t = +el.dataset.start;
    if (Number.isFinite(t)) { safeSeekPlay(t, true); e.preventDefault(); try { e.stopPropagation(); } catch {} }
  });
}

/* search panel */
(function setupSearch(){
  if (!els || !document.getElementById('searchInput')) return;
  const input = document.getElementById('searchInput');
  const btn = document.getElementById('searchBtn');
  const list = document.getElementById('searchResults');
  const prev = document.getElementById('searchPrev');
  const next = document.getElementById('searchNext');
  const pageInfo = document.getElementById('searchPageInfo');
  let state = { q: '', page: 1, perPage: 100, totalPages: 0, results: [], sel: -1 };
  let loading = false;

  function render() {
    pageInfo.textContent = state.totalPages ? `${state.page} / ${state.totalPages}` : '';
    prev.disabled = !(state.page > 1);
    next.disabled = !(state.page < state.totalPages);
    list.innerHTML = '';
    const frag = document.createDocumentFragment();
    state.results.forEach((r, i) => {
      const div = document.createElement('div');
      div.className = 'result-item' + (i === state.sel ? ' active' : '');
      const folderFile = String(r.source || '');
      const meta = document.createElement('div'); meta.className = 'meta';
      const dur = (Number(r.end_sec) - Number(r.start_sec));
      meta.textContent = `${folderFile} · ${Number.isFinite(dur) ? dur.toFixed(2)+'s' : ''}`;
      const snip = document.createElement('div'); snip.className = 'snippet';
      snip.textContent = String(r.text || '');
      div.appendChild(meta); div.appendChild(snip);
      div.addEventListener('click', () => onOpen(i));
      frag.appendChild(div);
    });
    list.appendChild(frag);
  }

  async function run(page = 1) {
    if (loading) return; loading = true;
    try {
      const q = input.value.trim(); if (!q) { state = { q:'', page:1, perPage:state.perPage, totalPages:0, results:[], sel:-1 }; render(); return; }
      const t0 = performance.now();
      const { results, pagination } = await searchApi({ q, page, perPage: state.perPage });
      state.q = q; state.page = pagination.page || page; state.totalPages = pagination.total_pages || 0; state.results = results || []; state.sel = state.results.length ? 0 : -1;
      // Enrich with segment text (snippet) via batch endpoint
      try {
        const lookups = state.results.map(r => ({ episode_idx: r.episode_idx, char_offset: r.char_offset }));
        const segs = await fetchSegApi(lookups);
        const key = (epi, ch) => `${epi}:${ch}`;
        const map = new Map(segs.map(s => [key(s.episode_idx, s.char_offset), s]));
        state.results = state.results.map(r => {
          const s = map.get(key(r.episode_idx, r.char_offset));
          return s ? { ...r, text: s.text, start_sec: s.start_sec ?? r.start_sec, end_sec: s.end_sec ?? r.end_sec, segment_idx: s.segment_index ?? r.segment_idx } : r;
        });
      } catch {}
      // Persist last query locally
      try { localStorage.setItem('v2:lastQuery', JSON.stringify({ q: state.q, page: state.page, ts: Date.now() })); } catch {}
      try { history.replaceState(null, '', `?q=${encodeURIComponent(q)}&page=${encodeURIComponent(state.page)}`); } catch {}
      render();
      // naive scroll to top
      try { list.scrollTop = 0; } catch {}
      // analytics-lite
      console.log('search', q, 'in', (performance.now()-t0).toFixed(0)+'ms', 'got', state.results.length);
    } catch (e) {
      try { console.warn('search failed', e); } catch {}
      try { const { showToast } = await import('./ui/toast.js'); showToast('יש להתחבר', 'error'); } catch {}
    } finally { loading = false; }
  }

  async function onOpen(i) {
    state.sel = i; render();
    const r = state.results[i]; if (!r) return;
    const ep = resultToEpisode(r); if (!ep) return;
    try {
      const start = Number(r.start_sec) || 0;
      // Update dataset for transcript for consistency with browser loader
      try {
        if (els.transcript) {
          els.transcript.dataset.folder = ep.folder;
          els.transcript.dataset.file = ep.file;
          // Provide hints for lazy/paged loaders
          if (Number.isFinite(r.segment_idx)) els.transcript.dataset.segmentHint = String(r.segment_idx);
          els.transcript.dataset.timeHint = String(start);
        }
      } catch {}
      const api = await import('./data/api.js');
      const episode = await api.loadEpisode({ folder: ep.folder, file: ep.file });
      // Mirror browser: set audio src and load
      try { if (els.player && episode?.audioUrl) { els.player.src = episode.audioUrl; els.player.load(); } } catch {}
      // Update store with tokens and baseline
      try {
        const initialText = (episode.initialTokens || []).map(t => t && t.word ? t.word : '').join('');
        store.setTokens(episode.initialTokens);
        store.setLiveText(initialText);
        store.setBaseline({ text: episode.baselineText, tokens: episode.baselineTokens });
        if (episode.version != null || episode.base_sha256) {
          store.setState({ version: episode.version || 0, base_sha256: episode.base_sha256 || '' }, 'version:init');
        } else {
          store.setState({ version: 0, base_sha256: '' }, 'version:clear');
        }
        // Load confirmations if available
        try {
          if (episode.version != null) {
            const filePath = `${ep.folder}/${ep.file}`;
            const confs = await api.getConfirmations(filePath, episode.version);
            const ranges = (confs || []).map(c => ({ id: c.id, range: c.range }));
            store.setConfirmedRanges(ranges);
          } else {
            store.setConfirmedRanges([]);
          }
        } catch {}
      } catch {}
      // Focus transcript near target token, with retries while tokens load
      try {
        const tryFocus = (attempts) => {
          const container = els.transcript;
          if (!container) return;
          // Try computing a target index from store tokens
          try {
            const st = getState();
            const toks = st.tokens && st.tokens.length ? st.tokens : (st.baselineTokens || []);
            if (Array.isArray(toks) && toks.length) {
              // binary search by start time
              let lo = 0, hi = toks.length - 1, ans = 0;
              while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                const s = +toks[mid].start || 0;
                if (s <= start) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
              }
              if (typeof virtualizer.scrollToTokenIndex === 'function') virtualizer.scrollToTokenIndex(ans);
            }
          } catch {}
          const spans = container.querySelectorAll('.word');
          let best = null, bestDelta = Infinity, maxT = -Infinity;
          spans.forEach(el => {
            const t = parseFloat(el.dataset.start || 'NaN');
            if (Number.isFinite(t)) {
              if (t > maxT) maxT = t;
              const d = Math.abs(t - start);
              if (d < bestDelta) { bestDelta = d; best = el; }
            }
          });
          const goodEnough = best && bestDelta < 0.25; // within 250ms
          if (goodEnough) {
            try { best.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch {}
            return;
          }
          // If not good enough but we can still load more (start is beyond maxT), retry
          if (attempts > 0 && Number.isFinite(maxT) && maxT + 0.5 < start) {
            setTimeout(() => tryFocus(attempts - 1), 150);
            return;
          }
          // Fallback: scroll to best we have so far
          if (best) { try { best.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch {} }
        };
        setTimeout(() => {
          tryFocus(20);
          // Lock karaoke scroll briefly to avoid tug-of-war, then seek & play
          try { if (els.transcript) els.transcript.dataset.scrollLockUntil = String(Date.now() + 1500); } catch {}
          try { if (playerCtrl && typeof playerCtrl.seekTo === 'function') playerCtrl.seekTo(start); else els.player.currentTime = Math.max(0, start + 0.01); } catch {}
          try { const pr = els.player.play(); if (pr && pr.catch) pr.catch(()=>{}); } catch {}
        }, 120);
      } catch {}
    } catch (e) {
      try { console.warn('episode open failed', e); } catch {}
      try { const { showToast } = await import('./ui/toast.js'); showToast('יש להתחבר', 'error'); } catch {}
    }
  }

  // wire
  if (btn) btn.addEventListener('click', () => run(1));
  if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(1); });
  if (prev) prev.addEventListener('click', () => { if (state.page > 1) run(state.page - 1); });
  if (next) next.addEventListener('click', () => { if (state.page < state.totalPages) run(state.page + 1); });
  // keyboard nav in list
  list?.addEventListener('keydown', (e) => {
    if (!state.results.length) return;
    if (e.key === 'ArrowDown') { state.sel = Math.min(state.results.length - 1, (state.sel < 0 ? 0 : state.sel + 1)); render(); e.preventDefault(); }
    if (e.key === 'ArrowUp') { state.sel = Math.max(0, (state.sel < 0 ? 0 : state.sel - 1)); render(); e.preventDefault(); }
    if (e.key === 'Enter' && state.sel >= 0) { onOpen(state.sel); e.preventDefault(); }
  });

  // On load: run only when URL has ?q=. Otherwise, just prefill from last query without running.
  try {
    const u = new URL(location.href);
    const q0 = u.searchParams.get('q') || '';
    const p0 = parseInt(u.searchParams.get('page') || '1', 10) || 1;
    if (q0) { input.value = q0; run(p0); }
    else {
      // Prefill from last query but do NOT auto-run
      try {
        const raw = localStorage.getItem('v2:lastQuery');
        if (raw) {
          const { q } = JSON.parse(raw);
          if (q) { input.value = q; }
        }
      } catch {}
    }
  } catch {}
})();

// Diff layers (show all dmp_patch rows)
setupShowLayers(els, workers);

// Words pager: progressively load words in segment chunks when backend is present
(function initWordsPager(){
  try {
    const pager = setupWordsPager(els, virtualizer, { chunkSegs: 50 });
    // Start/stop on doc change
    const onDocChange = () => { try { pager.stop(); } catch {}; setTimeout(() => pager.start(), 50); };
    // Mark doc changes when browser sets dataset
    const mo = new MutationObserver((mut) => {
      for (const m of mut) {
        if (m.type === 'attributes' && m.attributeName === 'data-file') {
          els.transcript?.dispatchEvent(new CustomEvent('v2:doc-change'));
          onDocChange();
        }
      }
    });
    if (els.transcript) mo.observe(els.transcript, { attributes: true });
    // Also start once after initial load
    setTimeout(() => pager.start(), 500);
  } catch {}
})();
/* simple tabs wiring for Browser/Search and Diff/History */
(function setupTabs(){
  try {
    const tabsets = [
      { a: 'tabBrowser', b: 'tabSearch', pa: 'panelBrowser', pb: 'panelSearch' },
      { a: 'tabDiff', b: 'tabHistory', pa: 'panelDiff', pb: 'panelHistory' }
    ];
    for (const t of tabsets) {
      const a = document.getElementById(t.a), b = document.getElementById(t.b);
      const pa = document.getElementById(t.pa), pb = document.getElementById(t.pb);
      if (!a || !b || !pa || !pb) continue;
      const selA = () => { a.setAttribute('aria-selected','true'); b.setAttribute('aria-selected','false'); pa.hidden = false; pb.hidden = true; };
      const selB = () => { a.setAttribute('aria-selected','false'); b.setAttribute('aria-selected','true'); pa.hidden = true; pb.hidden = false; };
      a.addEventListener('click', selA);
      b.addEventListener('click', selB);
      // default keep A selected
      selA();
    }
  } catch {}
})();

// Debug toggle: Ctrl+Shift+D flips localStorage('v2:debug') on/off and toasts state.
try {
  const getDebug = () => ((localStorage.getItem('v2:debug') || '').toLowerCase() === 'on');
  const setDebug = (on) => { try { localStorage.setItem('v2:debug', on ? 'on' : 'off'); } catch {} };
  window.toggleV2Debug = () => {
    const next = !getDebug(); setDebug(next);
    try { showToast(next ? 'Debug logs: ON' : 'Debug logs: OFF', next ? 'success' : 'info'); } catch {}
    try { console.log(`[dbg] debug=${next?'on':'off'}`); } catch {}
    return next;
  };
  window.addEventListener('keydown', (e) => {
    try {
      if (e && e.ctrlKey && e.shiftKey && (e.key === 'D' || e.key === 'd')) {
        e.preventDefault(); window.toggleV2Debug();
      }
    } catch {}
  });
  if (getDebug()) { try { console.log('[dbg] Debug logs enabled'); } catch {} }
} catch {}
