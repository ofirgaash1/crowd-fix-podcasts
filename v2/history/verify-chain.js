// v2/history/verify-chain.js
// Verify latest hash directly; if edit history is available, optionally validate chain.

import { canonicalizeText } from '../shared/canonical.js';
import { getTranscriptVersion, getTranscriptEdits, getLatestTranscript, sha256Hex } from '../data/api.js';

export async function verifyChainHash(filePath) {
  try {
    const latest = await getLatestTranscript(filePath);
    if (!latest) return { ok: true, reason: 'no-version' };

    // Simple, robust: compare hash of latest.text to base_sha256
    const h = await sha256Hex(canonicalizeText(latest.text || ''));
    const expected = latest.base_sha256 || '';
    if (!!expected && h === expected) return { ok: true, expected };

    // Optional: try to diagnose using chain if history is available
    try {
      const v1 = await getTranscriptVersion(filePath, 1);
      if (!v1) return { ok: false, reason: 'missing-v1', got: h, expected };
      let text = canonicalizeText(v1.text || '');
      const edits = (await getTranscriptEdits(filePath)).sort((a, b) => (a.child_version - b.child_version));
      for (const e of edits) {
        let ops = [];
        try { ops = JSON.parse(e.token_ops || e.dmp_patch || '[]'); } catch { ops = []; }
        if (!Array.isArray(ops)) return { ok: false, reason: 'bad-ops', at: e.child_version, got: h, expected };
        const reconNew = (ops) => { try { return (ops || []).map(([op, s]) => (op === -1 ? '' : String(s || ''))).join(''); } catch { return ''; } };
        const reconOld = (ops) => { try { return (ops || []).map(([op, s]) => (op ===  1 ? '' : String(s || ''))).join(''); } catch { return ''; } };
        const oldOk = canonicalizeText(reconOld(ops)) === text;
        if (!oldOk) return { ok: false, reason: 'ops-dont-match-parent', at: e.child_version, got: h, expected };
        text = reconNew(ops);
      }
      const h2 = await sha256Hex(text);
      if (h2 === expected) return { ok: true, expected };
      return { ok: false, reason: 'direct-mismatch', got: h, expected };
    } catch {
      return { ok: false, reason: 'direct-mismatch', got: h, expected };
    }
  } catch (err) {
    return { ok: false, reason: 'exception', message: err?.message || String(err) };
  }
}

export default { verifyChainHash };
