// v2/history/layers-view.js
// Build diff layers HTML from transcript snapshots using the diff worker.

import { canonicalizeText, lineTrim } from '../shared/canonical.js';

/**
 * @param {string} filePath
 * @param {Array<{version:number,text:string}>} versions ordered ASC
 * @param {(a:string,b:string, meta?:{parentV:number,childV:number,aFull:string,bFull:string,aMid:string,bMid:string})=>Promise<Array<[number,string]>>} getDiff - async function to get diffs
 * @returns {Promise<string>} HTML string
 */
export async function buildLayersHTML(filePath, versions, getDiff, timingMap) {
  const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  if (!Array.isArray(versions) || versions.length <= 1) {
    return `<div class="hint">אין שכבות שינויים זמינות</div>`;
  }
  let html = `<div class="hint">שכבות שינויים עבור ${escapeHtml(filePath)}</div>`;

  for (let k = 1; k < versions.length; k++) {
    const parentV = versions[k - 1]?.version;
    const childV = versions[k]?.version;
    const aFull = canonicalizeText(versions[k - 1]?.text || '');
    const bFull = canonicalizeText(versions[k]?.text || '');
    const [aMid, bMid] = lineTrim(aFull, bFull);
    if (aMid === bMid) continue;
    let diffs = [];
    try { diffs = await getDiff(aMid, bMid, { parentV, childV, aFull, bFull, aMid, bMid }); } catch { diffs = []; }
    const filtered = Array.isArray(diffs) ? diffs.filter(x => Array.isArray(x) && (x[0] === 1 || x[0] === -1)) : [];
    try {
      const childUser = versions[k]?.user || '';
      if (childUser) { html += `<div class="hint" style="margin-inline-start:6px">מאת ${escapeHtml(childUser)}</div>`; }
    } catch {}
    html += `<div class="layer"><div class="hint">— v${escapeHtml(parentV)} → v${escapeHtml(childV)}</div>`;
    const rowHtml = filtered.map(([op, text]) => {
      const safe = escapeHtml(text || '');
      return op === 1 ? `<span class="diff-insert">${safe}</span>` : `<span class="diff-delete">${safe}</span>`;
    }).join('');
    html += `<div class="diff-row" dir="auto">${rowHtml || '<span class="hint">(אין הבדלים להצגה)</span>'}</div>`;

    // Optional: render timing changes if provided for this child version
    try {
      const tOps = timingMap && (timingMap.get ? timingMap.get(childV) : timingMap[childV]);
      if (tOps && tOps.length) {
        const blocks = [];
        for (const blk of tOps) {
          if (!blk || blk.type !== 'timing_adjust') continue;
          const items = Array.isArray(blk.items) ? blk.items : [];
          const rows = items.slice(0, 50).map(it => {
            const w = escapeHtml(String(it.word||''));
            const os = Number(it.old_start||0).toFixed(3);
            const ns = Number(it.new_start||0).toFixed(3);
            const oe = Number(it.old_end||0).toFixed(3);
            const ne = Number(it.new_end||0).toFixed(3);
            const ds = (Number(it.delta_start||0) >= 0 ? '+' : '') + Number(it.delta_start||0).toFixed(3);
            const de = (Number(it.delta_end||0) >= 0 ? '+' : '') + Number(it.delta_end||0).toFixed(3);
            return `<div class="timing-row"><span class="word">${w}</span> · start ${os}→${ns} (${ds}), end ${oe}→${ne} (${de})</div>`;
          }).join('');
          const segInfo = (blk.segment_start != null && blk.segment_end != null) ? ` (קטעים ${blk.segment_start}–${blk.segment_end})` : '';
          blocks.push(`<div class="timing-block"><div class="hint">⏱ שינויים בתזמונים${segInfo}</div>${rows || '<div class="hint">(אין שינויים מדידים)</div>'}</div>`);
        }
        if (blocks.length) {
          html += `<div class="timing-layer">${blocks.join('')}</div>`;
        }
      }
    } catch {}

    html += `</div>`; // end layer
  }
  return html;
}


