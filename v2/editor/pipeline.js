// v2/editor/pipeline.js
// Editing coordinator: diff (fast) + align (heavy) with IME guard, quiet window, and generation guards

import { store, getState } from '../core/state.js';
import { renderDiffHTML } from '../render/diff-panel.js';

export function setupEditorPipeline(els, { workers, virtualizer, getDocKey, editGenRef, setTypingQuietUntil, isIdle, nowMs }) {
  if (!els?.transcript) throw new Error('#transcript missing');

  els.transcript.contentEditable = 'true';
  els.transcript.spellcheck = false;
  els.transcript.setAttribute('dir', 'auto');

  let composing = false;
  els.transcript.addEventListener('compositionstart', () => { composing = true; });
  els.transcript.addEventListener('compositionend', () => {
    composing = false;
    editGenRef.value++;
    setTypingQuietUntil(nowMs() + 1200);
    scheduleDiffSync(0, /*leading*/true);
    scheduleTokensFromText(0, /*leading*/true);
  });

  const pushLiveText = () => { const txt = (els.transcript?.innerText || '').replace(/\r/g, ''); store.setLiveText(txt); };

  // debounce helper (local)
  function makeDebounce(fn, wait = 150) { let t=0, lead=false; const debounced = (ms, leading=false)=>{ const d=(typeof ms==='number')?ms:wait; if(leading&&!lead){ lead=true; Promise.resolve().then(fn).finally(()=>{lead=false;}); return;} clearTimeout(t); t=setTimeout(fn,d); }; return debounced; }

  let diffRetryCount = 0; const maxDiffRetries = 10;
  const scheduleDiffSync = makeDebounce(async () => {
    const st = getState(); const docAtStart = getDocKey(); const genAtStart = editGenRef.value; const liveAtStart = st.liveText;
    if (!st.baselineText) { renderDiffHTML(els.diffBody, []); return; }
    if (!workers.diffReady()) { if (diffRetryCount < maxDiffRetries) { diffRetryCount++; setTimeout(() => scheduleDiffSync(), 100); } else { diffRetryCount=0; } return; }
    diffRetryCount=0;
    try {
      const t0 = performance.now();
      const { diffs } = await workers.diff.send(st.baselineText, liveAtStart, { timeoutSec: 0.8, editCost: 8 });
      const stNow = getState(); if (docAtStart !== getDocKey() || genAtStart !== editGenRef.value || stNow.liveText !== liveAtStart) return;
      if (!isShowingLayers()) renderDiffHTML(els.diffBody, diffs);
    } catch (err) { console.warn('diff failed:', err?.message || err); }
  }, 150);

  // Simple local tokenization (no alignment). Splits text into runs and inserts \n tokens.
  function tokensFromText(str) {
    const out = [];
    const s = String(str || '');
    for (const ch of s) {
      if (ch === '\n') { out.push({ word: '\n', start: 0, end: 0, probability: null }); }
      else { out.push({ word: ch, start: 0, end: 0, probability: null }); }
    }
    return out;
  }
  const scheduleTokensFromText = makeDebounce(async () => {
    const st = getState(); const docAtStart = getDocKey(); const genAtStart = editGenRef.value; const liveAtStart = st.liveText;
    const sel = getSelectionOffsets(els.transcript);
    try {
      const toks = tokensFromText(liveAtStart);
      const stNow = getState(); if (docAtStart !== getDocKey() || genAtStart !== editGenRef.value || stNow.liveText !== liveAtStart) return;
      if (nowMs() < getTypingQuietUntil()) return;
      // Avoid clobbering aligned tokens with zeroed placeholders after save.
      const hasTiming = (arr) => {
        if (!Array.isArray(arr)) return false;
        for (const t of arr) {
          const s = (t && Number.isFinite(t.start)) ? +t.start : 0;
          const e = (t && Number.isFinite(t.end)) ? +t.end : 0;
          if (s > 0 || e > 0) return true;
        }
        return false;
      };
      if (hasTiming(stNow.tokens) && !hasTiming(toks)) { try { if ((localStorage.getItem('v2:debug')||'').toLowerCase()==='on') console.debug('[dbg] tokensFromText: skipped to preserve aligned timings'); } catch {} return; }
      store.setTokens(toks);
    } finally {
      if (sel && nowMs() >= getTypingQuietUntil()) setSelectionByOffsets(els.transcript, sel[0], sel[1]);
    }
  }, 300);

  els.transcript.addEventListener('input', () => { if (composing) return; editGenRef.value++; setTypingQuietUntil(nowMs() + 1200); hideLayers(); pushLiveText(); scheduleDiffSync(); scheduleTokensFromText(); });

  pushLiveText();

  // wait for workers readiness (simple loop kept local)
  let workerWaitAttempts = 0; const maxWorkerWaitAttempts = 50;
  const waitForWorkers = () => { if (workers.isReady()) { scheduleDiffSync(0, true); scheduleTokensFromText(0, true); } else if (workerWaitAttempts < maxWorkerWaitAttempts) { workerWaitAttempts++; setTimeout(waitForWorkers, 100); } };
  waitForWorkers();
}

// Utilities copied from main (kept minimal) — If needed, move to shared util.
function getSelectionOffsets(container) {
  const sel = window.getSelection(); if (!sel || sel.rangeCount === 0) return null; const r = sel.getRangeAt(0);
  const inC = n => n && (n === container || container.contains(n)); if (!(inC(r.startContainer) && inC(r.endContainer))) return null;
  const measure = (node, off) => { const rng = document.createRange(); rng.selectNodeContents(container); try { rng.setEnd(node, off); } catch { return 0; } return rng.toString().length; };
  const s = measure(r.startContainer, r.startOffset); const e = measure(r.endContainer, r.endOffset); return [Math.min(s, e), Math.max(s, e)];
}
function setSelectionByOffsets(container, start, end) {
  const text = (container?.innerText || '').replace(/\r/g, ''); const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const S = clamp(start || 0, 0, text.length); const E = clamp((end == null ? S : end), 0, text.length);
  const tw = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, null); let pos = 0, n, sNode = container, sOff = 0, eNode = container, eOff = 0;
  while ((n = tw.nextNode())) { const len = n.nodeValue.length; if (pos + len >= S && sNode === container) { sNode = n; sOff = S - pos; } if (pos + len >= E) { eNode = n; eOff = E - pos; break; } pos += len; }
  const sel = window.getSelection(); const rng = document.createRange(); try { rng.setStart(sNode, sOff); rng.setEnd(eNode, eOff); } catch { return; }
  sel.removeAllRanges(); sel.addRange(rng); container.focus();
}

// Layer view integration hooks (weak-coupled)
let _showingLayers = false; export function setShowingLayers(on){ _showingLayers = !!on; }
function isShowingLayers(){ return _showingLayers; }
function hideLayers(){ _showingLayers = false; }

// Typing quiet window registry (shared through closures)
let _typingQuietUntil = 0; export function getTypingQuietUntil(){ return _typingQuietUntil; }
export function setTypingQuiet(ms){ _typingQuietUntil = ms; }
