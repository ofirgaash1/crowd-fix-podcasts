// v2/history/verify-chain.js
// Verify that composing v1 + all saved edit ops reproduces the latest version's hash

import { canonicalizeText } from '../shared/canonical.js';
import { getTranscriptVersion, getTranscriptEdits, getLatestTranscript, sha256Hex } from '../data/api.js';

const reconNew = (ops) => {
  try { return (ops || []).map(([op, s]) => (op === -1 ? '' : String(s || ''))).join(''); } catch { return ''; }
};
const reconOld = (ops) => {
  try { return (ops || []).map(([op, s]) => (op ===  1 ? '' : String(s || ''))).join(''); } catch { return ''; }
};

export async function verifyChainHash(filePath) {
  try {
    const latest = await getLatestTranscript(filePath);
    if (!latest) return { ok: true, reason: 'no-version' };

    const v1 = await getTranscriptVersion(filePath, 1);
    if (!v1) return { ok: false, reason: 'missing-v1' };

    // Start from canonicalized v1 text
    let text = canonicalizeText(v1.text || '');
    const edits = (await getTranscriptEdits(filePath)).sort((a, b) => (a.child_version - b.child_version));

    for (const e of edits) {
      let ops = [];
      try { ops = JSON.parse(e.token_ops || e.dmp_patch || '[]'); } catch { ops = []; }
      if (!Array.isArray(ops)) return { ok: false, reason: 'bad-ops', at: e.child_version };
      const oldOk = canonicalizeText(reconOld(ops)) === text;
      if (!oldOk) return { ok: false, reason: 'ops-dont-match-parent', at: e.child_version };
      text = reconNew(ops);
    }

    const h = await sha256Hex(text);
    const expected = latest.base_sha256 || '';
    return { ok: !!expected && h === expected, got: h, expected };
  } catch (err) {
    return { ok: false, reason: 'exception', message: err?.message || String(err) };
  }
}

export default { verifyChainHash };

