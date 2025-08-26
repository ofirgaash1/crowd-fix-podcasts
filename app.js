// app.js
// Glue code for data.js + view.js + confirm.js
// Assumes your HTML has:
//   #folders, #files, #transcript, #player, #rate, #rateVal, #probToggle
//   #submitBtn, #dlVtt, #markReliable, #markUnreliable
// Optional: #fontPlus, #fontMinus, #settingsBtn, #modal, #hfToken, #mSave, #mClear, #mClose

import { createDataAPI } from './data.js';
import { normalizeData, flattenToTokens } from './model.js';
import { TranscriptView } from './view.js';
import { ConfirmFeature } from './confirm.js';

/* ----------------------------- Config / State ----------------------------- */

const SUPABASE_URL = 'https://xblbzxyyoptnfrlffigv.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InhibGJ6eHl5b3B0bmZybGZmaWd2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTU3ODI1MjgsImV4cCI6MjA3MTM1ODUyOH0.eIB279AoKwL5mrXuX1BQxa1mevVXMPrZK2VLaZ5kTNE';

const els = {
  folders: document.getElementById('folders'),
  files: document.getElementById('files'),
  transcript: document.getElementById('transcript'),
  player: document.getElementById('player'),
  rate: document.getElementById('rate'),
  rateVal: document.getElementById('rateVal'),
  probToggle: document.getElementById('probToggle'),
  submitBtn: document.getElementById('submitBtn'),
  dlVtt: document.getElementById('dlVtt'),
  markYes: document.getElementById('markReliable'),
  markNo: document.getElementById('markUnreliable'),
  fontPlus: document.getElementById('fontPlus'),
  fontMinus: document.getElementById('fontMinus'),
  settingsBtn: document.getElementById('settingsBtn'),
  modal: document.getElementById('modal'),
  hfToken: document.getElementById('hfToken'),
  mSave: document.getElementById('mSave'),
  mClear: document.getElementById('mClear'),
  mClose: document.getElementById('mClose'),
};

const api = createDataAPI({ supabaseUrl: SUPABASE_URL, supabaseAnonKey: SUPABASE_KEY });

const view = new TranscriptView({
  els: {
    transcript: els.transcript,
    rate: els.rate,
    rateVal: els.rateVal,
    probToggle: els.probToggle,
  },
  config: {
    probThreshold: 0.95,
    probEnabled: true,
    probBelowThresholdOnly: true, // perf: only store probs < 0.95 on nodes
  },
});

const confirm = new ConfirmFeature({ api, view });

const state = {
  currentFolder: null,
  currentFile: null,
  currentFileNode: null,
  objUrl: null,           // for audio blob revoke
  correctionsCache: new Set(), // file_path strings
  loadCtl: { ac: null, token: 0 }, // for aborting loads
};

/* --------------------------------- Helpers -------------------------------- */

function revokeObjUrl() {
  if (state.objUrl) {
    try { URL.revokeObjectURL(state.objUrl); } catch {}
    state.objUrl = null;
  }
}

function enc(p) { return p.split('/').map(encodeURIComponent).join('/'); }

function t2(t) {
  if (!Number.isFinite(t)) return '00:00:00.000';
  const h = ('0' + Math.floor(t / 3600)).slice(-2);
  const m = ('0' + Math.floor(t % 3600 / 60)).slice(-2);
  const s = ('0' + Math.floor(t % 60)).slice(-2);
  const ms = ('00' + Math.floor((t % 1) * 1000)).slice(-3);
  return `${h}:${m}:${s}.${ms}`;
}

function buildVtt(data) {
  const segs = data.segments || [];
  let out = 'WEBVTT\n\n';
  segs.forEach((seg, i) => {
    out += `${i + 1}\n${t2(seg.start || 0)} --> ${t2(seg.end || (seg.start || 0) + 0.25)}\n${seg.text || ''}\n\n`;
  });
  return out;
}

function showToast(msg) {
  // minimal inline toast replacement for alerts; swap with your UI if you have one
  console.log(msg);
}

/* ------------------------------ Settings modal ---------------------------- */

(function settingsInit() {
  if (!els.settingsBtn || !els.modal) return;

  const TOKEN_KEY = 'hfToken';
  const getTok = () => localStorage.getItem(TOKEN_KEY) || '';
  const setTok = (t) => t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY);

  els.settingsBtn.addEventListener('click', () => {
    els.modal.classList.add('open');
    els.hfToken && (els.hfToken.value = getTok());
    requestAnimationFrame(() => els.hfToken?.focus());
  });
  els.modal.addEventListener('click', (e) => {
    if (e.target === els.modal) els.modal.classList.remove('open');
  });
  els.mSave?.addEventListener('click', () => {
    setTok(els.hfToken.value.trim());
    els.modal.classList.remove('open');
  });
  els.mClear?.addEventListener('click', () => {
    setTok('');
    if (els.hfToken) els.hfToken.value = '';
  });
  els.mClose?.addEventListener('click', () => els.modal.classList.remove('open'));
})();

/* ----------------------------- Folders / Files ---------------------------- */

async function loadAllCorrections() {
  try {
    state.correctionsCache = await api.loadAllCorrectionPaths();
  } catch (e) {
    console.warn('loadAllCorrections failed:', e);
  }
}

function markFile(filePath, hasCorrection) {
  const fileName = filePath.split('/').pop();
  const el = els.files?.querySelector?.(`[data-file="${CSS.escape(fileName)}"]`);
  if (!el) return;
  el.style.background = hasCorrection ? 'rgba(0,255,0,.08)' : 'rgba(255,0,0,.08)';
}

async function loadFolders() {
  if (!els.folders) return;
  els.folders.innerHTML = '<div class="hint">טוען תיקיות…</div>';
  try {
    const folders = await api.listFolders();
    els.folders.innerHTML = folders.map(d => `<button class="item" data-folder="${d}">${d}</button>`).join('');
  } catch (e) {
    els.folders.innerHTML = `<div class="err">${e.message || e}</div>`;
  }
}

async function selectFolder(folder, node) {
  state.currentFolder = folder;
  if (!els.files) return;
  [...els.folders.children].forEach(el => el.classList.toggle('active', el === node));
  els.files.innerHTML = '<div class="hint">טוען קבצים…</div>';
  try {
    const files = await api.listOpusFiles(folder);
    if (!files.length) {
      els.files.innerHTML = '<div class="hint">אין קבצי OPUS בתיקייה זו</div>';
      return;
    }
    els.files.innerHTML = files.map(f => {
      const display = f.replace(/\.opus$/i, '');
      return `<button class="item" data-folder="${folder}" data-file="${f}">${display}</button>`;
    }).join('');
    // apply correction tint
    files.forEach(f => markFile(folder + '/' + f, state.correctionsCache.has(folder + '/' + f)));
  } catch (e) {
    els.files.innerHTML = `<div class="err">${e.message || e}</div>`;
  }
}

async function selectEpisode(folder, file, node) {
  if (node) {
    if (state.currentFileNode) state.currentFileNode.classList.remove('active');
    state.currentFileNode = node;
    state.currentFileNode.classList.add('active');
  }
  state.currentFolder = folder;
  state.currentFile = file;

  const { audioPath, trPath } = api.normPaths(folder, file);

  // abort previous
  state.loadCtl.ac?.abort();
  const ac = new AbortController();
  state.loadCtl = { ac, token: (state.loadCtl.token + 1) };

  try {
    revokeObjUrl();
    showToast('טוען תמליל…');

    // Prefer corrected JSON
    let corrected = null;
    try {
      corrected = await api.getCorrection(audioPath);
    } catch (e) {
      console.warn('Supabase getCorrection failed:', e);
    }

    let raw = corrected;
    if (!raw) {
      try {
        raw = await api.fetchTranscript(trPath, { signal: ac.signal });
      } catch (e) {
        if (e?.message?.startsWith?.('401')) {
          showToast('צריך hf_token כדי לגשת לתמליל. פתח גלגל שיניים והזן טוקן.');
        }
        throw e;
      }
    }

    if (state.loadCtl.ac !== ac) return; // outdated

    const norm = normalizeData(raw);
    const tokens = flattenToTokens(norm).map(t => ({ ...t, state: 'keep' }));
    view.setBaseline(tokens, norm);

    // load confirmations
    confirm.setFilePath(audioPath);

    // audio
    showToast('טוען אודיו…');
    try {
      const blob = await api.fetchAudioBlob(audioPath, { signal: ac.signal });
      if (state.loadCtl.ac !== ac) return;
      revokeObjUrl();
      state.objUrl = URL.createObjectURL(blob);
      els.player.src = state.objUrl;
    } catch (e) {
      // fallback to public URL (if repo is public)
      console.warn('Audio blob fetch failed, falling back to direct URL:', e);
      els.player.src = api.opusUrl(audioPath);
    }
    view.setAudioElement(els.player);
    els.player.playbackRate = parseFloat(els.rate?.value || '1') || 1;
    els.player.currentTime = 0.01;

    // mark file color
    markFile(audioPath, !!corrected);
  } catch (e) {
    if (e.name !== 'AbortError') {
      console.error(e);
      showToast(`שגיאה: ${e.message || e}`);
    }
  }
}

/* --------------------------------- Saving --------------------------------- */

els.submitBtn?.addEventListener('click', async () => {
  try {
    const data = view.getData();
    const filePath = state.currentFolder && state.currentFile
      ? `${state.currentFolder}/${state.currentFile}`
      : null;
    if (!filePath) { showToast('אין קובץ נבחר'); return; }
    await api.upsertCorrection(filePath, data);
    await loadAllCorrections();
    markFile(filePath, true);
    showToast('✅ נשמר למסד הנתונים');
  } catch (e) {
    console.error(e);
    showToast('❌ שגיאה בשמירה: ' + (e.message || e));
  }
});

/* --------------------------------- VTT DL --------------------------------- */

els.dlVtt?.addEventListener('click', () => {
  const blob = new Blob([buildVtt(view.getData())], { type: 'text/vtt' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const base = (document.title || 'transcript').replace(/[^\w.-]+/g, '_');
  a.download = `${base}.vtt`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

/* ---------------------------- Confirm buttons UI --------------------------- */

function updateMarkButtons() {
  if (!els.markYes || !els.markNo) return;
  const sel = view.getSelectionOffsets();
  if (!sel) {
    els.markYes.style.display = '';
    els.markNo.style.display = 'none';
    return;
  }
  const frac = confirm.selectionCoverage();
  if (frac <= 0) {        // nothing covered -> allow "mark reliable"
    els.markYes.style.display = '';
    els.markNo.style.display = 'none';
  } else if (frac >= 1) { // fully covered -> allow "mark unreliable"
    els.markYes.style.display = 'none';
    els.markNo.style.display = '';
  } else {                // partial overlap -> show both
    els.markYes.style.display = '';
    els.markNo.style.display = '';
  }
}

els.markYes?.addEventListener('pointerdown', e => e.preventDefault());
els.markNo?.addEventListener('pointerdown', e => e.preventDefault());
els.markYes?.addEventListener('click', async () => {
  try { await confirm.markReliable(); updateMarkButtons(); }
  catch (e) { console.error(e); showToast('שגיאה בסימון אמין'); }
});
els.markNo?.addEventListener('click', async () => {
  try { await confirm.markUnreliable(); updateMarkButtons(); }
  catch (e) { console.error(e); showToast('שגיאה בסימון כלא אמין'); }
});
view.on('selection', updateMarkButtons);
view.on('change', updateMarkButtons);

/* ------------------------------ Font size UI ------------------------------- */

(function textSizeInit() {
  const LS_KEY = 'text-size-rem';
  function readInitial() {
    const saved = parseFloat(localStorage.getItem(LS_KEY));
    if (Number.isFinite(saved)) return saved;
    const px = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
    const trPx = parseFloat(getComputedStyle(els.transcript || document.body).fontSize) || (1.1 * px);
    return trPx / px;
  }
  let sizeRem = readInitial();
  function apply() {
    document.documentElement.style.setProperty('--text-size', sizeRem.toFixed(2) + 'rem');
    if (els.transcript) els.transcript.style.fontSize = sizeRem.toFixed(2) + 'rem';
    localStorage.setItem(LS_KEY, String(sizeRem));
  }
  apply();
  els.fontPlus?.addEventListener('click', () => { sizeRem = Math.min(sizeRem + 0.10, 2.00); apply(); });
  els.fontMinus?.addEventListener('click', () => { sizeRem = Math.max(sizeRem - 0.10, 0.60); apply(); });
})();

/* ------------------------------- Wire clicks ------------------------------- */

els.folders?.addEventListener('click', (e) => {
  const item = e.target.closest?.('.item[data-folder]');
  if (item) selectFolder(item.dataset.folder, item);
});
els.files?.addEventListener('click', (e) => {
  const item = e.target.closest?.('.item[data-file]');
  if (item) selectEpisode(item.dataset.folder, item.dataset.file, item);
});

/* ------------------------------- Boot sequence ----------------------------- */

async function init() {
  await loadAllCorrections();
  await loadFolders();
  window.addEventListener('beforeunload', revokeObjUrl);
}
init();
