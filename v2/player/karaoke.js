// v2/player/karaoke.js
// Highlight active word by currentTime and gently auto-scroll

import { store, getState } from '../core/state.js';

export function setupKaraokeFollow(els, virtualizer) {
  let lastIdx = -1;
  let starts = [], ends = [];

  const rebuildIndex = () => {
    const toks = getState().tokens && getState().tokens.length ? getState().tokens : (getState().baselineTokens || []);
    starts = new Array(toks.length);
    ends = new Array(toks.length);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i] || {};
      starts[i] = Number.isFinite(t.start) ? +t.start : NaN;
      ends[i] = Number.isFinite(t.end) ? +t.end : NaN;
    }
  };

  const indexByStart = (t) => {
    // binary search for last start <= t
    let lo = 0, hi = starts.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const s = starts[mid];
      if (!Number.isFinite(s)) { hi = mid - 1; continue; }
      if (s <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return ans;
  };

  // Update index whenever tokens/baseline change
  store.subscribe((state, tag) => {
    if (tag === 'tokens' || tag === 'baseline') rebuildIndex();
  });
  rebuildIndex();

  function tick() {
    const st = getState();
    const t = st.playback?.currentTime || 0;
    if (!starts.length || st.playback?.paused) { requestAnimationFrame(tick); return; }

    let i = indexByStart(t);
    if (i < 0) i = 0;
    const inRange = (k) => (k >= 0 && k < starts.length && Number.isFinite(starts[k]) && Number.isFinite(ends[k]) && t >= starts[k] && t <= ends[k]);
    if (!inRange(i)) {
      const next = i + ((ends[i] || 0) < t ? 1 : -1);
      if (inRange(next)) i = next;
      else {
        for (let k = Math.max(0, i - 5); k < Math.min(starts.length, i + 5); k++) { if (inRange(k)) { i = k; break; } }
      }
    }

    if (i !== lastIdx && i >= 0) {
      virtualizer.updateActiveIndex(i);
      const sp = els.transcript?.querySelector(`span.word[data-ti="${i}"]`);
      if (sp) {
        try { sp.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }); } catch {}
      }
      lastIdx = i;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

