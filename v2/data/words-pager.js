// v2/data/words-pager.js
// Incrementally load words from backend in segment chunks and feed the virtualizer/store

import { api } from './api.js';
import { store } from '../core/state.js';

export function setupWordsPager(els, virtualizer, { chunkSegs = 50 } = {}) {
  let running = false;
  let abort = false;

  async function start() {
    if (running) return; running = true; abort = false;
    const folder = els.transcript?.dataset.folder || '';
    const file = els.transcript?.dataset.file || '';
    const doc = `${folder}/${file}`;
    const version = store.getState()?.version || 0;
    if (!doc || !version) { running = false; return; }

    let seg = 0;
    const all = [];
    while (!abort) {
      const words = await api.getTranscriptWords(doc, version, { segment: seg, count: chunkSegs });
      if (!Array.isArray(words) || words.length === 0) break;
      all.push(...words);
      virtualizer.setTokens(all);
      try { store.setTokens(all); } catch {}
      seg += chunkSegs;
      // small pause to keep UI responsive
      await new Promise(r => setTimeout(r, 20));
    }
    running = false;
  }

  function stop() { abort = true; }
  return { start, stop };
}

