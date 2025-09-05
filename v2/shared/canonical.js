// v2/shared/canonical.js
// Canonicalization helpers for text stability across versions and diffs.

export function canonicalizeText(s) {
  try {
    let t = String(s || '');
    // Normalize newlines
    t = t.replace(/\r/g, '');
    // Replace NBSP with regular space
    t = t.replace(/\u00A0/g, ' ');
    // Strip bidi/invisible formatting chars
    t = t.replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');
    // Trim trailing spaces on each line
    t = t.replace(/[ \t]+$/gm, '');
    return t;
  } catch {
    return String(s || '');
  }
}

// Trim unchanged prefix/suffix by lines; return [aMid, bMid]
export function lineTrim(a, b) {
  const A = String(a || '').split('\n');
  const B = String(b || '').split('\n');
  let pre = 0;
  while (pre < A.length && pre < B.length && A[pre] === B[pre]) pre++;
  let post = 0;
  while (post < (A.length - pre) && post < (B.length - pre) && A[A.length - 1 - post] === B[B.length - 1 - post]) post++;
  const aMid = A.slice(pre, A.length - post).join('\n');
  const bMid = B.slice(pre, B.length - post).join('\n');
  return [aMid, bMid];
}

