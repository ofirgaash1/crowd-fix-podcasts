// v2/history/show-layers.js
// Wire the "Show Layers" button and render diff layers into the diff panel.

import { showToast } from '../ui/toast.js';
import { buildLayersHTML } from './layers-view.js';
import { setShowingLayers as setLayersFlag } from '../editor/pipeline.js';
import { getAllTranscripts } from '../data/api.js';

export function setupShowLayers(els, workers) {
  if (!els?.showLayersBtn) return;
  els.showLayersBtn.addEventListener('click', async () => {
    try {
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
      });

      if (els.diffBody) {
        try { setLayersFlag(true); } catch {}
        els.diffBody.innerHTML = html;
      }
    } catch (e) {
      console.error('Failed to load diff layers:', e);
      try { showToast('שגיאה בטעינת שכבות', 'error'); } catch {}
    }
  });
}
