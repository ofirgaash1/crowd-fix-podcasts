// v2/main.js
// App bootstrap + modeless editing coordinator (diff + align workers).

import { store, getState, makeThrottle } from './core/state.js';
import { ScrollVirtualizer } from './render/virtualizer.js';
import { setupPlayerSync } from './player/sync.js';
import { setupBrowser } from './data/browser.js';
import { setupSupabase } from './data/supabase-init.js';
import { setupShowLayers } from './history/show-layers.js';
import { setupScrollSync, setupGutters } from './ui/layout.js';
import { setupKaraokeFollow } from './player/karaoke.js';
import { setupSettingsModal } from './ui/settings-modal.js';
import { setupThemeToggle } from './ui/theme.js';
import { setupUIControls } from './ui/controls.js';
import { setupHud } from './ui/hud.js';
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
  settingsBtn: document.getElementById('settingsBtn'),
  modal: document.getElementById('modal'),
  hfToken: document.getElementById('hfToken'),
  mSave: document.getElementById('mSave'),
  mClear: document.getElementById('mClear'),
  mClose: document.getElementById('mClose'),
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

// Configure Supabase (enables save + correction markers)
const supaReady = setupSupabase();

// Initialize browser (folder/file listing) after (or regardless of) Supabase init
Promise.resolve(supaReady).catch(() => { }).finally(() => {
  setupBrowser(els, { bumpEditGen: () => { editGen++; } });
});

// Initialize settings modal
setupSettingsModal(els);

// Initialize theme toggle
setupThemeToggle(els);

// Wire UI controls (rate, VTT, font, confirm, back-to-top)
setupUIControls(els, { workers }, virtualizer, playerCtrl, isIdle);

// Gutters and scroll sync
setupGutters(els);
setupScrollSync(els);

// Karaoke follow (highlight + gentle auto-scroll)
setupKaraokeFollow(els, virtualizer);

/* transcript interactions */
// Alt+click a word to seek/play from its start (keeps normal click for editing)
if (els.transcript && els.player) {
  els.transcript.addEventListener('click', (e) => {
    if (!e.altKey) return;
    const el = e.target && e.target.closest ? e.target.closest('.word') : null;
    if (!el) return;
    const t = +el.dataset.start;
    if (Number.isFinite(t)) {
      try { els.player.currentTime = Math.max(0, t + 0.01); } catch {}
      try { els.player.play(); } catch {}
      e.preventDefault();
    }
  });

  // Right-click a word to seek/play and suppress the context menu
  els.transcript.addEventListener('contextmenu', (e) => {
    const el = e.target && e.target.closest ? e.target.closest('.word') : null;
    if (!el) return;
    const t = +el.dataset.start;
    if (Number.isFinite(t)) {
      try { els.player.currentTime = Math.max(0, t + 0.01); } catch {}
      try { els.player.play(); } catch {}
      e.preventDefault();
    }
  });
}

// Diff layers (show all dmp_patch rows)
setupShowLayers(els, workers);
