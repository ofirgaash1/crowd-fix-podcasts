// v2/history/layers-view.js
// Build diff layers HTML from transcript snapshots using the diff worker.

import { canonicalizeText, lineTrim } from '../shared/canonical.js';

/**
 * @param {string} filePath
 * @param {Array<{version:number,text:string}>} versions ordered ASC
 * @param {(a:string,b:string, meta?:{parentV:number,childV:number,aFull:string,bFull:string,aMid:string,bMid:string})=>Promise<Array<[number,string]>>} getDiff - async function to get diffs
 * @returns {Promise<string>} HTML string
 */
export async function buildLayersHTML(filePath, versions, getDiff) {
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
    html += `<div class="layer"><div class="hint">— v${escapeHtml(parentV)} → v${escapeHtml(childV)}</div>`;
    const rowHtml = filtered.map(([op, text]) => {
      const safe = escapeHtml(text || '');
      return op === 1 ? `<span class="diff-insert">${safe}</span>` : `<span class="diff-delete">${safe}</span>`;
    }).join('');
    html += `<div class="diff-row" dir="auto">${rowHtml || '<span class="hint">(אין הבדלים להצגה)</span>'}</div></div>`;
  }
  return html;
}
