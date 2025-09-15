// v2/history/show-layers.js
// Wire the "Show Layers" button and render diff layers into the diff panel.

import { showToast } from '../ui/toast.js';
import { buildLayersHTML } from './layers-view.js';
import { setShowingLayers as setLayersFlag } from '../editor/pipeline.js';
import { getAllTranscripts, getTranscriptEdits } from '../data/api.js';

let layersOpen = false;

async function renderLayersForCurrent(els, workers) {
  const folder = els.transcript?.dataset.folder;
  const file = els.transcript?.dataset.file;
  if (!folder || !file) return;
  const filePath = `${folder}/${file}`;

  try { showToast('מחשב שכבות…', 'info'); } catch {}
  const versions = await getAllTranscripts(filePath);
  if (!versions || versions.length <= 1) {
    try { showToast('אין שכבות שינויים זמינות', 'info'); } catch {}
    return;
  }

  // Fetch timing edits map (child_version -> list of ops)
  let timingMap = new Map();
  try {
    const edits = await getTranscriptEdits(filePath);
    if (Array.isArray(edits)) {
      const byChild = new Map();
      for (const e of edits) {
        const cv = e && e.child_version;
        if (!Number.isFinite(+cv)) continue;
        let ops = [];
        try {
          const parsed = (typeof e.token_ops === 'string') ? JSON.parse(e.token_ops) : e.token_ops;
          if (Array.isArray(parsed)) ops = parsed;
          else if (parsed && typeof parsed === 'object') ops = [parsed];
        } catch { /* ignore */ }
        if (!byChild.has(cv)) byChild.set(cv, []);
        if (ops && ops.length) byChild.get(cv).push(...ops);
      }
      timingMap = byChild;
    }
  } catch {}

  const html = await buildLayersHTML(filePath, versions, async (a, b, meta) => {
    const parentV = meta?.parentV ?? '?';
    const childV = meta?.childV ?? '?';
    const tag = `layers:v${parentV}->v${childV}`;
    try {
      console.groupCollapsed(`[layers] ${filePath} v${parentV} -> v${childV}`);
      const vis = (s) => String(s).replace(/\n/g, '⏎').replace(/ /g, '␠');
      console.log('a.len', (meta?.aFull||'').length, 'b.len', (meta?.bFull||'').length);
      console.log('a.preview', vis((meta?.aFull||'').slice(0, 120)));
      console.log('b.preview', vis((meta?.bFull||'').slice(0, 120)));
    } catch {}
    const { diffs } = await workers.diff.send(a, b, { timeoutSec: 0.8, editCost: 8, debugTag: tag });
    try {
      const ops = Array.isArray(diffs) ? diffs : [];
      const inserted = ops.filter(x=>x[0]===1).map(x=>x[1]).join('');
      const deleted  = ops.filter(x=>x[0]===-1).map(x=>x[1]).join('');
      const eq_len = ops.filter(x=>x[0]===0).reduce((n,x)=>n+String(x[1]||'').length,0);
      const vis = (s) => String(s).replace(/\n/g, '⏎').replace(/ /g, '␠');
      console.log('insert.len', inserted.length, 'delete.len', deleted.length, 'equal.len', eq_len, 'ops', ops.length);
      console.log('insert.preview', vis(inserted.slice(0, 120)));
      console.log('delete.preview', vis(deleted.slice(0, 120)));
      console.groupEnd?.();
    } catch {}
    return diffs;
  }, timingMap);

  if (els.diffBody) {
    try { setLayersFlag(true); } catch {}
    els.diffBody.innerHTML = html;
    layersOpen = true;
  }
}

export function setupShowLayers(els, workers) {
  if (!els?.showLayersBtn) return;
  els.showLayersBtn.addEventListener('click', async () => {
    try {
      await renderLayersForCurrent(els, workers);
    } catch (e) {
      console.error('Failed to load diff layers:', e);
      try { showToast('שגיאה בטעינת שכבות', 'error'); } catch {}
    }
  });
}

export function refreshLayers(els, workers) {
  if (!layersOpen) return;
  // fire and forget; errors handled in handler
  renderLayersForCurrent(els, workers).catch(() => {});
}
