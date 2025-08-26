// model.js
// Core transcript model:
// - Tokenization (runs-based, newline-aware)
// - Normalization <-> flattening between {segments,words} and tokens
// - Fast token diff (Myers O(ND)) from baseline tokens to edited text
// - Assign timings for inserted tokens from neighbors' anchors
// - Chronology repair + validation
//
// No DOM, no storage, no fetches.

// ----- constants (as requested) -----
export const EPS = 1e-2;           // 10ms epsilon
export const MIN_WORD_DUR = 0;     // keep EXACTLY 0 (caller may change later)

// ----- helpers -----
export const isWS = (s) => /^\s+$/u.test(s);
export const isNewline = (s) => s === '\n';
const finite = Number.isFinite;

// ----- tokenization (runs-based; '\n' is its own token) -----
/**
 * Convert plain text into tokens (strings), splitting into:
 * - '\n' as a standalone token
 * - runs of non-newline whitespace ("  ", "\t", etc.)
 * - runs of non-whitespace (words / punctuation clusters)
 */
export function tokenizeRuns(text) {
  const out = [];
  let buf = '';
  let bufIsWS = null; // null until first char
  for (const ch of Array.from(String(text || ''))) {
    if (ch === '\n') {
      if (buf) { out.push(buf); buf = ''; bufIsWS = null; }
      out.push('\n');
      continue;
    }
    const chIsWS = /\s/u.test(ch);
    if (buf === '') {
      buf = ch; bufIsWS = chIsWS;
    } else if (bufIsWS === chIsWS) {
      buf += ch;
    } else {
      out.push(buf);
      buf = ch; bufIsWS = chIsWS;
    }
  }
  if (buf) out.push(buf);
  return out;
}

// ----- data normalization ↔ tokens -----
/**
 * Ensure minimal well-formed transcript object.
 * Coerces numbers, backfills words when absent.
 */
export function normalizeData(raw) {
  const d = JSON.parse(JSON.stringify(raw || {}));
  d.text = d.text || '';
  d.segments = Array.isArray(d.segments) ? d.segments : [];
  d.segments.forEach((s) => {
    s.start = +s.start || 0;
    s.end = +s.end || (s.start + 0.25);
    if (!Array.isArray(s.words) || s.words.length === 0) {
      const txt = String(s.text || ' ');
      s.words = [{ word: txt, start: s.start, end: s.end }];
    } else {
      s.words.forEach((w) => {
        w.word = String(w.word ?? '');
        w.start = +w.start || 0;
        w.end = +w.end || (w.start + 0.25);
        if (w.probability != null && finite(+w.probability)) {
          w.probability = +w.probability;
        } else {
          delete w.probability;
        }
      });
    }
  });
  return d;
}

/**
 * Flatten normalized data -> tokens (with '\n' between segments).
 * Keeps probability on word tokens when present.
 */
export function flattenToTokens(d) {
  const toks = [];
  let lastEnd = 0;
  (d.segments || []).forEach((s, si) => {
    (s.words || []).forEach((w) => {
      toks.push({
        word: String(w.word || ''),
        start: +w.start || 0,
        end: +w.end || ((+w.start || 0) + 0.25),
        state: 'keep',
        probability: finite(+w.probability) ? +w.probability : NaN,
      });
      lastEnd = toks[toks.length - 1].end;
    });
    if (si < d.segments.length - 1) {
      toks.push({ word: '\n', start: lastEnd, end: lastEnd, state: 'keep', probability: NaN });
    }
  });
  return toks;
}

/**
 * Join non-deleted tokens into plain text.
 */
export function wordsToText(tokens) {
  return tokens.filter(t => t.state !== 'del').map(t => t.word).join('');
}

/**
 * Convert tokens back to normalized data (segments/words).
 * Aggregates whitespace prefix onto the following non-whitespace word.
 */
export function tokensToData(tokens) {
  const segs = [];
  let pendingWS = '';
  let pendingS = Infinity;
  let words = [];
  for (const t of tokens) {
    if (t.state === 'del') continue;
    if (isNewline(t.word)) {
      // flush current segment
      if (words.length) segs.push(words);
      words = [];
      pendingWS = '';
      pendingS = Infinity;
      continue;
    }
    if (isWS(t.word)) {
      pendingWS += t.word;
      if (finite(t.start)) pendingS = Math.min(pendingS, t.start);
      continue;
    }
    // non-WS token
    const start = finite(pendingS) ? Math.min(pendingS, t.start) : t.start;
    const end = t.end;
    const wordStr = pendingWS + t.word;
    const probability = finite(t.probability) ? t.probability : undefined;
    const w = { word: wordStr, start, end };
    if (probability != null) w.probability = probability;
    words.push(w);
    pendingWS = '';
    pendingS = Infinity;
  }
  if (words.length) segs.push(words);

  const segments = segs.map((ws) => {
    const starts = ws.map(w => w.start).filter(finite);
    const ends = ws.map(w => w.end).filter(finite);
    const t0 = starts.length ? Math.min(...starts) : 0;
    const t1 = ends.length ? Math.max(...ends) : 0.25;
    return { start: t0, end: t1, text: ws.map(w => w.word).join(''), words: ws };
  });

  return { text: segments.map(s => s.text).join('\n'), segments };
}

// ----- baseline normalization for diff -----
/**
 * Split baseline tokens into runs suitable for diffing.
 * - Preserves '\n' as-is
 * - Splits other tokens into runs of WS (non-newline) and non-WS
 * - WS runs get an anchor time (start=end) inside the original span
 */
export function normalizeBaselineForDiff(baselineTokens) {
  const out = [];
  for (const t of baselineTokens) {
    const txt = String(t.word || '');
    const prob = finite(t.probability) ? t.probability : NaN;

    if (txt === '\n') {
      out.push({ word: '\n', start: t.start, end: t.end, probability: NaN });
      continue;
    }
    if (!txt) {
      out.push({ word: '', start: t.start, end: t.end, probability: NaN });
      continue;
    }

    const parts = tokenizeRuns(txt); // yields '\n', ws-runs, non-ws runs
    let pos = 0;
    for (const p of parts) {
      const from = pos; pos += p.length;
      if (p === '\n') {
        // '\n' wasn't inside words in practice; ignore inside a token:
        const anchor = t.start; // safe fallback
        out.push({ word: '\n', start: anchor, end: anchor, probability: NaN });
      } else if (isWS(p)) {
        const span = Math.max(0, (t.end || 0) - (t.start || 0));
        const L = Math.max(1, txt.length);
        const anchor = (t.start || 0) + span * (from / L);
        out.push({ word: p, start: anchor, end: anchor, probability: NaN });
      } else {
        out.push({ word: p, start: t.start, end: t.end, probability: prob });
      }
    }
  }
  return out;
}

// ----- Myers O(ND) diff on arrays of strings -----
/**
 * @returns {Array<{type:'equal'|'insert'|'delete', length:number}>}
 */
export function myersEdits(a, b) {
  const N = a.length, M = b.length;
  const MAX = N + M;
  /** @type {Array<Map<number, number>>} */
  const trace = [];
  let V = new Map();
  V.set(1, 0);

  for (let d = 0; d <= MAX; d++) {
    trace.push(new Map(V));
    for (let k = -d; k <= d; k += 2) {
      const km1 = V.get(k - 1) ?? -Infinity;
      const kp1 = V.get(k + 1) ?? -Infinity;
      let x;
      if (k === -d || (k !== d && km1 < kp1)) {
        x = kp1; // down: insertion in a→b path
      } else {
        x = km1 + 1; // right: deletion
      }
      let y = x - k;
      while (x < N && y < M && a[x] === b[y]) { x++; y++; }
      V.set(k, x);
      if (x >= N && y >= M) {
        return backtrackEdits(trace, a, b);
      }
    }
  }
  return []; // shouldn't reach
}

function backtrackEdits(trace, a, b) {
  let x = a.length, y = b.length;
  /** @type {Array<{type:'equal'|'insert'|'delete', length:number}>} */
  const ops = [];
  for (let d = trace.length - 1; d >= 0; d--) {
    const V = trace[d];
    const k = x - y;
    let prevK;
    const km1 = V.get(k - 1) ?? -Infinity;
    const kp1 = V.get(k + 1) ?? -Infinity;

    if (k === -d || (k !== d && km1 < kp1)) {
      prevK = k + 1; // came from down (insert)
    } else {
      prevK = k - 1; // came from right (delete)
    }
    const prevX = V.get(prevK) ?? 0;
    const prevY = prevX - prevK;

    // equal snake
    let equalLen = 0;
    while (x > prevX && y > prevY) { x--; y--; equalLen++; }
    if (equalLen) ops.push({ type: 'equal', length: equalLen });

    if (d === 0) break;

    // the step (one edit)
    if (x === prevX) {
      // insertion (in b)
      ops.push({ type: 'insert', length: 1 });
      y--;
    } else {
      // deletion (from a)
      ops.push({ type: 'delete', length: 1 });
      x--;
    }
  }
  ops.reverse();

  // coalesce adjacent same-type
  const out = [];
  for (const op of ops) {
    const last = out[out.length - 1];
    if (last && last.type === op.type) last.length += op.length;
    else out.push({ ...op });
  }
  return out;
}

// ----- Build from baseline tokens to edited text -----
/**
 * Compute tokens for edited text based on baseline tokens (fast diff).
 * Returns a new token array with states: 'keep' | 'del' | 'ins'.
 */
export function buildFromBaseline(baselineTokens, newText) {
  const A = normalizeBaselineForDiff(baselineTokens);
  const B = tokenizeRuns(newText);
  const aWords = A.map(t => t.word);

  const script = myersEdits(aWords, B);
  const out = [];
  let i = 0, j = 0;

  for (const step of script) {
    const n = step.length;
    if (step.type === 'equal') {
      for (let k = 0; k < n; k++) {
        const w = A[i++];
        out.push({ word: w.word, start: w.start, end: w.end, state: 'keep', probability: w.probability });
      }
    } else if (step.type === 'delete') {
      for (let k = 0; k < n; k++) {
        const w = A[i++];
        out.push({ word: w.word, start: w.start, end: w.end, state: 'del', probability: w.probability });
      }
    } else { // insert
      for (let k = 0; k < n; k++) {
        const w = B[j++];
        out.push({ word: w, start: NaN, end: NaN, state: 'ins', probability: NaN });
      }
    }
  }

  assignTimesFromAnchors(out);  // MIN_WORD_DUR == 0 per your requirement
  return out;
}

// ----- Timing assignment from anchors -----
function placeable(t) {
  return t.state !== 'del' && !isNewline(t.word);
}
function leftNeighbor(arr, idx) {
  for (let k = idx - 1; k >= 0; k--) if (placeable(arr[k]) && finite(arr[k].end)) return arr[k];
  return null;
}
function rightNeighbor(arr, idx) {
  for (let k = idx; k < arr.length; k++) if (placeable(arr[k]) && finite(arr[k].start)) return arr[k];
  return null;
}
function nearestEarlierStartLT(arr, time, fromIdx) {
  for (let k = fromIdx - 1; k >= 0; k--) {
    const t = arr[k];
    if (!placeable(t)) continue;
    if (finite(t.start) && t.start < time - EPS) return t;
  }
  return null;
}
function nearestLaterStartGT(arr, time, fromIdx) {
  for (let k = fromIdx; k < arr.length; k++) {
    const t = arr[k];
    if (!placeable(t)) continue;
    if (finite(t.start) && t.start > time + EPS) return t;
  }
  return null;
}

/**
 * Assign start/end times to inserted tokens using neighbor anchors.
 * Keeps existing times for 'keep'/'del' tokens intact.
 * MIN_WORD_DUR is 0 (by design here).
 */
export function assignTimesFromAnchors(arr) {
  let i = 0;
  while (i < arr.length) {
    if (arr[i].state !== 'ins') { i++; continue; }
    let j = i; while (j < arr.length && arr[j].state === 'ins') j++;
    const slice = arr.slice(i, j);

    const L = leftNeighbor(arr, i);
    const R = rightNeighbor(arr, j);

    let lo = finite(L?.end) ? L.end : (finite(L?.start) ? L.start : 0);
    let hi = finite(R?.start) ? R.start : (finite(L?.end) ? L.end + 0.5 : lo + 0.5);
    const pivot = finite(R?.start) ? R.start : (finite(L?.end) ? L.end : 0);

    if (!(hi - lo > EPS)) {
      const earlier = nearestEarlierStartLT(arr, pivot, i);
      const later = nearestLaterStartGT(arr, pivot, j);
      if (earlier) lo = Math.max(lo, finite(earlier.end) ? earlier.end : earlier.start);
      if (later) hi = Math.min(hi, later.start);
      if (!(hi - lo > EPS)) {
        // conservative fallback span
        if (!finite(R?.start) && finite(L?.end)) {
          lo = L.end + EPS; hi = lo + 0.24;
        } else if (finite(R?.start) && !finite(L?.end)) {
          hi = R.start - EPS; lo = Math.max(0, hi - 0.24);
        } else if (finite(R?.start) && finite(L?.end)) {
          hi = R.start - EPS;
          lo = Math.max(0, hi - 0.24, finite(L?.end) ? L.end + EPS : -Infinity);
          if (!(hi - lo > EPS)) lo = hi; // allow zero-span
        } else {
          lo = 0; hi = 0.24;
        }
      }
    }

    // distribute anchors (words vs whitespace)
    const wordIdxs = slice.map((t, ix) => (isWS(t.word) ? -1 : ix)).filter(ix => ix >= 0);
    const wordCount = wordIdxs.length;
    const span = Math.max(hi - lo, MIN_WORD_DUR * Math.max(1, wordCount));
    const step = wordCount > 0 ? (span / (wordCount + 1)) : span;

    let nth = 0;
    let lastAssigned = lo - EPS;
    for (let k2 = 0; k2 < slice.length; k2++) {
      const g = arr[i + k2];
      if (isWS(g.word)) {
        const anchor = Math.min(hi - EPS, Math.max(lo + EPS, lastAssigned + EPS));
        g.start = g.end = anchor;
        lastAssigned = g.start;
        continue;
      }
      nth++;
      let s = lo + step * nth;
      s = Math.max(s, lastAssigned + EPS, lo + EPS);
      s = Math.min(s, hi); // MIN_WORD_DUR is 0
      let e = Math.max(s, Math.min(hi - EPS, s + MIN_WORD_DUR));
      if (e < s) e = s; // allow zero-length
      g.start = s;
      g.end = e;
      lastAssigned = g.start;
    }

    // local monotonicity
    let prev = lo - EPS;
    for (let k3 = i; k3 < j; k3++) {
      const t = arr[k3];
      const ws = isWS(t.word);
      if (!finite(t.start)) t.start = prev + EPS;
      if (!finite(t.end)) t.end = t.start + (ws ? 0 : MIN_WORD_DUR);
      if (t.start < prev - EPS) t.start = prev + EPS;
      if (t.end < t.start) t.end = t.start + (ws ? 0 : MIN_WORD_DUR);
      prev = t.start;
    }

    i = j;
  }

  // global pass: ensure numbers + non-decreasing starts for placeables
  let prev = -Infinity;
  for (const t of arr) {
    if (t.state === 'del' || isNewline(t.word)) continue;
    const ws = isWS(t.word);
    if (!finite(t.start)) t.start = prev + EPS;
    if (!finite(t.end)) t.end = t.start + (ws ? 0 : MIN_WORD_DUR);
    if (t.start < prev - EPS) {
      if (t.state === 'ins' || ws) {
        t.start = prev + EPS;
        if (t.end < t.start) t.end = t.start + (ws ? 0 : MIN_WORD_DUR);
      } else {
        // keep baseline 'keep' anchors even if slightly out-of-order
      }
    }
    if (t.end < t.start) t.end = t.start + (ws ? 0 : MIN_WORD_DUR);
    prev = Math.max(prev, t.start);
  }

  // round to milliseconds
  for (const t of arr) {
    if (finite(t.start)) t.start = +t.start.toFixed(3);
    if (finite(t.end)) t.end = +t.end.toFixed(3);
  }
}

/**
 * Adjust times minimally to restore monotonicity (non-decreasing start).
 * Keeps MIN_WORD_DUR = 0 behavior.
 */
export function repairChronology(tokens) {
  let prevStart = -Infinity;
  for (const t of tokens) {
    if (t.state === 'del' || isNewline(t.word)) continue;
    const ws = isWS(t.word);
    if (!finite(t.start)) t.start = prevStart + EPS;
    if (!finite(t.end)) t.end = t.start + (ws ? 0 : MIN_WORD_DUR);
    if (t.start < prevStart - EPS) {
      t.start = prevStart + EPS;
      if (t.end < t.start) t.end = t.start + (ws ? 0 : MIN_WORD_DUR);
    }
    prevStart = Math.max(prevStart, t.start);
  }
  for (const t of tokens) {
    if (finite(t.start)) t.start = +t.start.toFixed(3);
    if (finite(t.end)) t.end = +t.end.toFixed(3);
  }
}

/**
 * Validate chronology. Returns { ok, issues[] }.
 * Treats zero-length words as valid; flags only hard inversions.
 */
export function validateChronology(tokens) {
  const issues = [];
  let prevStart = -Infinity;
  tokens.forEach((t, i) => {
    if (t.state === 'del' || isNewline(t.word)) return;
    const s = t.start, e = t.end;
    const label = `${i}:${JSON.stringify(t.word)} [${s}→${e}]`;
    if (!finite(s) || !finite(e)) { issues.push(`NaN time at ${label}`); return; }
    if (e < s - EPS) issues.push(`end<start at ${label}`);
    if (s + EPS < prevStart) {
      const ws = isWS(t.word);
      if (t.state === 'keep') {
        // prefer to accept baseline anchors; set prevStart and continue
        prevStart = s;
        return;
      }
      if (ws || e < prevStart) issues.push(`non-monotonic start at ${label} (prev ${prevStart})`);
      else issues.push(`soft overlap at ${label} (prev ${prevStart})`);
    } else {
      prevStart = Math.max(prevStart, s);
    }
  });
  return { ok: issues.length === 0, issues };
}

/**
 * High-level convenience: from baseline tokens + edited text
 * to { tokens, data } (normalized segments) with timings assigned.
 */
export function rebuildFromText(baselineTokens, editedText) {
  const tokens = buildFromBaseline(baselineTokens, editedText);
  repairChronology(tokens); // conservative second pass
  const data = tokensToData(tokens);
  return { tokens, data };
}
