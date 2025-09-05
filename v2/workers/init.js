// v2/workers/init.js
// Initialize diff/align workers and expose a tiny RPC wrapper.

export function initWorkers() {
  const diffW  = new Worker('./workers/diff-worker.js',  { type: 'module' });
  const alignW = new Worker('./workers/align-worker.js', { type: 'module' });

  let msgId = 1;
  const pending = new Map(); // id -> { resolve, reject, kind }
  let diffReady = false;
  let alignReady = false;

  try {
    diffW.postMessage({ type: 'init', baselineText: '' });
    alignW.postMessage({ type: 'init', baselineTokens: [] });
  } catch (err) {
    console.error('Worker initialization failed:', err);
  }

  function handleMessage(ev, kind) {
    const { id, type } = ev.data || {};
    if (type === `${kind}:ready`) {
      if (kind === 'diff') diffReady = true; else if (kind === 'align') alignReady = true;
      return;
    }
    if (!id || !pending.has(id)) return;
    const entry = pending.get(id);
    if (entry.kind !== kind) return;
    const { resolve, reject } = entry;
    pending.delete(id);
    if (type === `${kind}:result`) resolve(ev.data);
    else if (type === `${kind}:error`) reject(new Error(ev.data.message || `${kind} worker error`));
  }

  diffW.onmessage  = (ev) => handleMessage(ev, 'diff');
  alignW.onmessage = (ev) => handleMessage(ev, 'align');

  diffW.onerror  = (err) => { const e = new Error('Diff worker crashed'); for (const v of pending.values()) if (v.kind==='diff') v.reject(e); };
  alignW.onerror = (err) => { const e = new Error('Align worker crashed'); for (const v of pending.values()) if (v.kind==='align') v.reject(e); };

  const sendDiff = (base, current, options) => {
    if (!diffReady) return Promise.reject(new Error('Diff worker not ready'));
    const id = msgId++;
    // Pass baseline atomically with the diff request to avoid races
    const payload = { id, type: 'diff', baselineText: base, text: current, options };
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject, kind: 'diff' }); diffW.postMessage(payload); });
  };
  const setDiffBaseline = (baselineText) => { diffW.postMessage({ type: 'setBaseline', baselineText }); };

  const sendAlign = (baselineTokens, currentText) => {
    if (!alignReady) return Promise.reject(new Error('Align worker not ready'));
    const id = msgId++;
    const payload = { id, type: 'align', text: currentText };
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject, kind: 'align' }); alignW.postMessage(payload); });
  };
  const setAlignBaseline = (baselineTokens) => { alignW.postMessage({ type: 'setBaseline', baselineTokens }); };

  const terminateAll = () => {
    try { diffW.terminate(); } catch {}
    try { alignW.terminate(); } catch {}
    for (const { reject } of pending.values()) reject(new Error('Workers terminated'));
    pending.clear();
  };

  return {
    diff:  { send: sendDiff, setBaseline: setDiffBaseline },
    align: { send: sendAlign, setBaseline: setAlignBaseline },
    terminateAll,
    isReady: () => diffReady && alignReady,
    diffReady: () => diffReady,
    alignReady: () => alignReady,
  };
}
