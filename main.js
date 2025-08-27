// v2/main.js
// App bootstrap + modeless editing coordinator (diff + align workers).

import { store, getState, makeThrottle } from './core/state.js';
import { ScrollVirtualizer } from './render/virtualizer.js';
import { renderDiffHTML } from './render/diff-panel.js';
import { setupPlayerSync } from './player/sync.js'; // <-- ADD


/* =========================================================================
   DOM
   ========================================================================= */
const els = {
  transcript: document.getElementById('transcript'),
  diffBody:   document.getElementById('diffBody'),
  probToggle: document.getElementById('probToggle'),
  player:     document.getElementById('player'),
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

  function handleMessage(ev, kind) {
    const { id, type } = ev.data || {};
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

  diffW.onerror  = () => { const e = new Error('Diff worker crashed');  for (const v of pending.values()) if (v.kind==='diff')  v.reject(e); };
  alignW.onerror = () => { const e = new Error('Align worker crashed'); for (const v of pending.values()) if (v.kind==='align') v.reject(e); };

  const sendDiff = (base, current, options) => {
    const id = msgId++;
    const payload = { id, type: 'diff', base, current, options };
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject, kind: 'diff' });
      diffW.postMessage(payload);
    });
  };

  const sendAlign = (baselineTokens, currentText) => {
    const id = msgId++;
    const payload = { id, type: 'align', baselineTokens, currentText };
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
    diff:  { send: sendDiff  },
    align: { send: sendAlign },
    terminateAll,
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
  const scheduleDiffSync = makeDebounce(async () => {
    const st = getState();
    if (!st.baselineText) { renderDiffHTML(els.diffBody, []); return; }
    try {
      const { diffs } = await workers.diff.send(st.baselineText, st.liveText, { timeoutMs: 800, editCost: 8 });
      renderDiffHTML(els.diffBody, diffs);
    } catch (err) {
      // Keep UI responsive; show nothing on error
      console.warn('diff failed:', err?.message || err);
    }
  }, 150);

  // Align: throttle to at most once / 1000ms (user asked for ≤1 Hz heavy work)
  const scheduleAlignSync = makeThrottle(async () => {
    const st = getState();
    if (!Array.isArray(st.baselineTokens) || !st.baselineTokens.length) return;

    // Preserve caret across DOM rebuild
    const sel = getSelectionOffsets(els.transcript);

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
  scheduleDiffSync(0, true);
  scheduleAlignSync(0, true);

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
   Boot
   ========================================================================= */
const workers = initWorkers();

// Virtualized transcript view subscribes to store and paints tokens.
const virtualizer = new ScrollVirtualizer({ container: els.transcript });

// Player sync: keeps store.playback in sync + handles CustomEvent('v2:seek')
let playerCtrl = null;
if (els.player) {
  playerCtrl = setupPlayerSync(els.player, {
    seekTarget: els.transcript, // listens for v2:seek from the transcript
    playOnSeek: false,          // keep your current UX: seek without auto-play
    publishHz: 60               // cap publish rate
  });
}

// Initial baseline can be set elsewhere; for demo ensure tokens mirror baselineTokens if present:
const st0 = getState();

if (Array.isArray(st0.tokens) && st0.tokens.length) {
  virtualizer.setTokens(st0.tokens);
} else if (Array.isArray(st0.baselineTokens) && st0.baselineTokens.length) {
  virtualizer.setTokens(st0.baselineTokens);
}

// Keep view in sync with settings (prob highlighting)
virtualizer.setProbEnabled(!!getState().settings?.probEnabled);


// Editing pipeline (modeless)
setupEditorPipeline({ workers, virtualizer });
