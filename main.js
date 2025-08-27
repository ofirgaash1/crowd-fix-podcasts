// v2/main.js
import { store, getState, makeThrottle } from './core/state.js';
import { setupTranscriptView } from './render/virtualizer.js';
import { mountDiffOverlay } from './render/overlay.js';
import { loadPreferCorrection } from './data/api.js';

// ---------- DOM refs ----------
const root = document.getElementById('transcript');
const audio = document.getElementById('player');
const probBtn = document.getElementById('probToggle');
const themeBtn = document.getElementById('themeToggle');
const themeIcon = document.getElementById('themeIcon');

if (!root) throw new Error('#transcript not found');
root.setAttribute('contenteditable', 'true'); // mode-less editing

// ---------- Mount transcript & diff views ----------
const view = setupTranscriptView(root);
const diffRoot = document.getElementById('diffBody');
const diffView = mountDiffOverlay(diffRoot);

// ---------- Diff worker ----------
const diffWorker = new Worker('v2/workers/diff-worker.js', { type: 'module' });
let diffSeq = 0;
let lastSeqApplied = 0;
// ---------- Align worker ----------
const alignWorker = new Worker('v2/workers/align-worker.js', { type: 'module' });
let alignSeq = 0;
let latestLiveText = '';

function requestAlignFor(text) {
  const st = getState();
  const baselineTokens = st.baselineTokens || st.tokens || [];
  alignWorker.postMessage({ type: 'align', seq: alignSeq, baselineTokens, newText: text });
}

function requestDiffFor(text) {
  const st = getState();
  const base = st.baselineText ?? st.text ?? '';
  diffWorker.postMessage({ type: 'diff', seq: diffSeq, base, text });
}

diffWorker.onmessage = (ev) => {
  const msg = ev.data;
  if (!msg || msg.type !== 'diff-result') return;
  // drop stale results (out-of-order)
  if (msg.seq < diffSeq) return;
  lastSeqApplied = msg.seq;
  diffView.render(msg.diffs);
  // Kick alignment after a diff result (debounced edit already happened)
  if (latestLiveText != null) requestAlignFor(latestLiveText);
};

alignWorker.onmessage = (ev) => {
  const msg = ev.data;
  if (!msg || msg.type !== 'align-result') return;
  // Out-of-order protection
  if (msg.seq < alignSeq) return;
  // Update store and view
  try {
    store.setTokens(msg.tokens);
  } catch { }
  // Also push directly to the view in case the store doesn’t broadcast yet
  const st = getState();
  view.setTokens(st.tokens || msg.tokens || []);
};

// ---------- Seek on word click ----------
root.addEventListener('v2:seek', (e) => {
  const t = e?.detail?.time;
  if (Number.isFinite(t) && audio) {
    audio.currentTime = t + 0.01;
    audio.play().catch(() => { });
  }
});

// ---------- Player ↔ store time sync ----------
if (audio) {
  const pushTime = makeThrottle(() => {
    store.setPlaybackTime(audio.currentTime || 0, audio.playbackRate || 1);
  }, 50); // ~20fps is enough for word highlighting

  audio.addEventListener('timeupdate', pushTime, { passive: true });
  audio.addEventListener('ratechange', pushTime, { passive: true });
}

// ---------- Editing pipeline (mode-less) ----------
let composing = false;            // IME guard
const scheduleLiveSync = debounce(() => {
  if (composing) return;
  const text = (root.innerText || '').replace(/\r/g, '');
  latestLiveText = text;
  store.setLiveText(text);
  requestDiffFor(text);
}, 120);

root.addEventListener('compositionstart', () => { composing = true; });
root.addEventListener('compositionend', () => { composing = false; scheduleLiveSync(); });
root.addEventListener('input', scheduleLiveSync);

// ---------- Probability toggle ----------
if (probBtn) {
  function setProbUI() {
    const st = getState();
    const on = !!st.settings?.probEnabled;
    probBtn.setAttribute('aria-pressed', String(on));
    probBtn.textContent = on ? 'בטל הדגשה' : 'הדגש ודאות נמוכה';
  }

  // init from localStorage
  const saved = localStorage.getItem('probHL');
  const initial = (saved ?? 'on') !== 'off';
  store.updateSettings({ probEnabled: initial });
  setProbUI();

  probBtn.addEventListener('click', () => {
    const now = !getState().settings?.probEnabled;
    store.updateSettings({ probEnabled: now });
    localStorage.setItem('probHL', now ? 'on' : 'off');
    setProbUI();
    // virtualizer repaints on store change
  });
}

// ---------- Theme toggle (optional, if present) ----------
(function initThemeToggle() {
  if (!themeBtn || !themeIcon) return;
  const body = document.body;

  function applyTheme(mode) {
    if (mode === 'dark') {
      body.classList.add('dark-mode');
      themeIcon.textContent = '☀️';
    } else {
      body.classList.remove('dark-mode');
      themeIcon.textContent = '🌙';
    }
    localStorage.setItem('theme', mode);
  }

  const savedTheme = localStorage.getItem('theme');
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  applyTheme(savedTheme || (prefersDark ? 'dark' : 'light'));

  themeBtn.addEventListener('click', () => {
    const isDark = body.classList.contains('dark-mode');
    applyTheme(isDark ? 'light' : 'dark');
  });
})();

// ---------- Initial load (replace with your real selection) ----------
(async () => {
  try {
    // TODO: wire to your folder/file selection UI
    // If you already have current selection, call store.loadTranscript(...) directly.
    const folder = ''; // e.g., '2024-08-15'
    const file = '';   // e.g., 'episode-001.opus'

    if (folder && file) {
      const res = await loadPreferCorrection(folder, file);
      store.loadTranscript({
        filePath: res.filePath,
        versionMeta: res.versionMeta,
        text: res.text,
        tokens: res.tokens,
        confirmed: [], // confirmations will be reattached in a later step
      });
      // render initial tokens
      view.setTokens(getState().tokens || res.tokens || []);
      // render initial diff = baseline vs. current
      requestDiffFor(res.text || '');
    }
  } catch (err) {
    console.warn('Initial load skipped or failed:', err);
  }
})();

// ---------- utils ----------
function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}
