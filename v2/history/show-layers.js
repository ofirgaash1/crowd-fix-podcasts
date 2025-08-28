// v2/history/show-layers.js
// Wire the "Show Layers" button and render diff layers into the diff panel.

import { showToast } from '../ui/toast.js';
import { buildLayersHTML } from './layers-view.js';
import { setShowingLayers as setLayersFlag } from '../editor/pipeline.js';
import { getAllTranscripts, getTranscriptEdits } from '../data/api.js';

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

      // --- Dev log: compute and render diagnostic info into diff pane ---
      const edits = await getTranscriptEdits(filePath);
      const escapeHtml = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      const visNL = (s) => String(s).replace(/\n/g, '⏎');
      const visSP = (s) => String(s).replace(/ /g, '␠');

      const verOverview = versions.map(v => ({ version: v.version, len: (v.text||'').length, preview: visNL((v.text||'')).slice(0,120) }));
      const byV = new Map(versions.map(v => [v.version, v.text || '']));

      const flatOps = [];
      const aggRuns = [];
      const reconRows = [];
      const volRows = [];
      const eqJSON = [];

      for (const row of (edits || [])) {
        const childV = +row.child_version; const parentV = +row.parent_version;
        let ops = [];
        try { ops = Array.isArray(row.dmp_patch) ? row.dmp_patch : JSON.parse(row.dmp_patch || '[]'); } catch { ops = []; }
        let ord = 0;
        for (const o of ops) {
          const op = Array.isArray(o) ? (o[0]|0) : 0; const s = Array.isArray(o) ? String(o[1]||'') : '';
          flatOps.push({ child_version: childV, parent_version: parentV, ord: ++ord, op, s: visSP(visNL(s)) });
        }
        const inserted = ops.filter(x=>x[0]===1).map(x=>x[1]).join('');
        const deleted  = ops.filter(x=>x[0]===-1).map(x=>x[1]).join('');
        aggRuns.push({ parent_version: parentV, child_version: childV, inserted: visSP(visNL(inserted)) || null, deleted: visSP(visNL(deleted)) || null });
        const recon = ops.map(x => x[0] === -1 ? '' : (x[1] || '')).join('');
        const parentText = byV.get(parentV) || '';
        const childText  = byV.get(childV) || '';
        const matches = (recon === childText);
        reconRows.push({ parent_version: parentV, child_version: childV, matches_child: !!matches, recon_preview: visNL(recon).slice(0,120), child_preview: visNL(childText).slice(0,120) });
        const sumLen = (a,op) => a.reduce((acc,x)=> acc + (x[0]===op ? (String(x[1]||'').length) : 0), 0);
        const ins_len = sumLen(ops, 1), del_len = sumLen(ops, -1), eq_len = sumLen(ops, 0);
        const actual_len_delta = (childText.length - parentText.length);
        const recon_len_delta = (ins_len + eq_len - del_len);
        volRows.push({ parent_version: parentV, child_version: childV, ins_len, del_len, eq_len, actual_len_delta, recon_len_delta });
        let tok = null; try { tok = Array.isArray(row.token_ops) ? row.token_ops : JSON.parse(row.token_ops || '[]'); } catch {}
        const same_ops = JSON.stringify(ops) === JSON.stringify(tok);
        const n_ops = ops.length;
        eqJSON.push({ child_version: childV, same_ops, n_ops });
      }

      const devLog = {
        versions: verOverview,
        ops: flatOps,
        insert_delete: aggRuns,
        reconstruct_check: reconRows,
        volumes: volRows,
        consistency: eqJSON
      };
      const devHtml = `<div class="layer"><div class="hint">— DEV LOG (temporary)</div><pre>${escapeHtml(JSON.stringify(devLog, null, 2))}</pre></div>`;

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
        els.diffBody.innerHTML = devHtml + html;
      }
    } catch (e) {
      console.error('Failed to load diff layers:', e);
      try { showToast('שגיאה בטעינת שכבות', 'error'); } catch {}
    }
  });
}
