// v2/player/karaoke.js
// Highlight active word by currentTime and gently auto-scroll

import { store, getState } from '../core/state.js';

export function setupKaraokeFollow(els, virtualizer) {
  let lastIdx = -1;
  let starts = [], ends = [];
  // Baseline reference (full length) for deep seeks while DB words are still paging
  let baseStarts = [], baseEnds = [];

  const rebuildIndex = () => {
    const st = getState();
    const toks = st.tokens && st.tokens.length ? st.tokens : (st.baselineTokens || []);
    starts = new Array(toks.length);
    ends = new Array(toks.length);
    for (let i = 0; i < toks.length; i++) {
      const t = toks[i] || {};
      starts[i] = Number.isFinite(t.start) ? +t.start : NaN;
      ends[i] = Number.isFinite(t.end) ? +t.end : NaN;
    }
    const base = st.baselineTokens || [];
    baseStarts = new Array(base.length);
    baseEnds = new Array(base.length);
    for (let i = 0; i < base.length; i++) {
      const t = base[i] || {};
      baseStarts[i] = Number.isFinite(t.start) ? +t.start : NaN;
      baseEnds[i] = Number.isFinite(t.end) ? +t.end : NaN;
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
    // Use tokens to avoid selecting newline tokens ('\n') as active scroll anchors
    const toks = st.tokens && st.tokens.length ? st.tokens : (st.baselineTokens || []);
    const isWord = (k) => (toks[k] && toks[k].word !== '\n');
    const inRange = (k) => (k >= 0 && k < starts.length && isWord(k) && Number.isFinite(starts[k]) && Number.isFinite(ends[k]) && t >= starts[k] && t <= ends[k]);
    if (!inRange(i)) {
      const next = i + ((ends[i] || 0) < t ? 1 : -1);
      if (inRange(next)) i = next;
      else {
        // Search small neighborhood for a real word containing t
        for (let k = Math.max(0, i - 8); k < Math.min(starts.length, i + 8); k++) { if (inRange(k)) { i = k; break; } }
        // If still not found (e.g., at precise boundary), prefer the next non-newline token
        if (!isWord(i)) {
          let f = i; while (f < starts.length && !isWord(f)) f++;
          let b = i; while (b >= 0 && !isWord(b)) b--;
          if (isWord(f)) i = f; else if (isWord(b)) i = b;
        }
      }
    }

    if (i !== lastIdx && i >= 0) {
      virtualizer.updateActiveIndex(i);
      let sp = els.transcript?.querySelector(`span.word[data-ti="${i}"]`);
      if (!sp && typeof virtualizer.scrollToTokenIndex === 'function') {
        // Ensure the target token is within the rendered window. If current tokens are still paging
        // and do not include this time, approximate window position using baseline proportion.
        try {
          const tokensLen = (starts || []).length;
          const baseLen = (baseStarts || []).length;
          if (tokensLen > 0 && baseLen > 0) {
            // Compute baseline index for current time
            const baseIndexByStart = (t0) => {
              let lo = 0, hi = baseStarts.length - 1, ans = -1;
              while (lo <= hi) {
                const mid = (lo + hi) >> 1;
                const s = baseStarts[mid];
                if (!Number.isFinite(s)) { hi = mid - 1; continue; }
                if (s <= t) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
              }
              return Math.max(0, ans);
            };
            const bi = baseIndexByStart(t);
            const ratio = baseLen > 0 ? (bi / baseLen) : 0;
            const approxTi = Math.max(0, Math.min(tokensLen - 1, Math.floor(ratio * tokensLen)));
            virtualizer.scrollToTokenIndex(approxTi);
          } else {
            virtualizer.scrollToTokenIndex(i);
          }
        } catch {}
        sp = els.transcript?.querySelector(`span.word[data-ti="${i}"]`);
      }
      if (sp) {
        // Respect a temporary scroll lock (set by result-open flow) to avoid tug-of-war
        let lockUntil = NaN;
        try { lockUntil = parseFloat(els.transcript?.dataset?.scrollLockUntil || 'NaN'); } catch {}
        const locked = Number.isFinite(lockUntil) && Date.now() < lockUntil;
        if (!locked) {
          // If this is a large jump, center; otherwise use nearest for gentle scroll
          const bigJump = (Math.abs(i - lastIdx) > 200);
          try { sp.scrollIntoView({ block: bigJump ? 'center' : 'nearest', inline: 'nearest', behavior: 'smooth' }); } catch {}
        }
      }
      lastIdx = i;
    }
    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

