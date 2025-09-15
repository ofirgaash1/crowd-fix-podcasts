// v2/data/words-pager.js
// Incrementally load words from backend in segment chunks and feed the virtualizer/store

import { api } from './api.js';
import { store } from '../core/state.js';

export function setupWordsPager(els, virtualizer, { chunkSegs = 50 } = {}) {
  const dbg = (...args) => { try { if ((localStorage.getItem('v2:debug') || '').toLowerCase() === 'on') console.log(...args); } catch {} };
  let running = false;
  let abort = false;

  async function start() {
    if (running) return; running = true; abort = false;
    const folder = els.transcript?.dataset.folder || '';
    const file = els.transcript?.dataset.file || '';
    const doc = `${folder}/${file}`;
    const version = store.getState()?.version || 0;
    if (!doc || !version) { running = false; return; }
    dbg(`[dbg] pager:start doc=${doc} version=${version} chunk=${chunkSegs}`);
    // If tokens already present (full or near-full), skip pager to avoid overriding complete data
    try {
      const st = store.getState();
      const tokLen = Array.isArray(st.tokens) ? st.tokens.length : 0;
      const baseLen = Array.isArray(st.baselineTokens) ? st.baselineTokens.length : 0;
      if (tokLen && (!baseLen || tokLen >= baseLen || tokLen > 1000)) { running = false; return; }
    } catch {}

    // Optional jump-start near a hinted segment (from search result)
    let seg = 0;
    try {
      const hint = parseInt(els.transcript?.dataset?.segmentHint || 'NaN', 10);
      if (Number.isFinite(hint) && hint >= 0) seg = Math.max(0, hint - Math.floor(chunkSegs / 2));
    } catch {}
    const all = [];
    while (!abort) {
      const words = await api.getTranscriptWords(doc, version, { segment: seg, count: chunkSegs });
      if (!Array.isArray(words) || words.length === 0) break;
      all.push(...words);
      // Do not clobber if UI already has a longer or equal token list (e.g., post-align full fetch)
      try {
        const cur = store.getState();
        const curLen = Array.isArray(cur.tokens) ? cur.tokens.length : 0;
        if (curLen >= all.length) {
          // skip updating; keep existing tokens
        } else {
          virtualizer.setTokens(all);
          try { store.setTokens(all); } catch {}
        }
      } catch {
        virtualizer.setTokens(all);
        try { store.setTokens(all); } catch {}
      }
      seg += chunkSegs;
      // small pause to keep UI responsive
      await new Promise(r => setTimeout(r, 20));
    }
    dbg(`[dbg] pager:done tokens=${all.length}`);
    running = false;
  }

  function stop() { abort = true; }
  return { start, stop };
}
