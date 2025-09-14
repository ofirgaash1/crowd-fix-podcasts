// v2/workers/init.js
// Initialize diff/align workers and expose a tiny RPC wrapper.

export function initWorkers() {
  const diffW  = new Worker('./workers/diff-worker.js',  { type: 'module' });

  let msgId = 1;
  const pending = new Map(); // id -> { resolve, reject, kind }
  let diffReady = false;
  let alignReady = false; // deprecated (align handled server-side)

  try {
    diffW.postMessage({ type: 'init', baselineText: '' });
    // no align worker
  } catch (err) {
    console.error('Worker initialization failed:', err);
  }

  function handleMessage(ev, kind) {
    const { id, type } = ev.data || {};
    if (type === `${kind}:ready`) {
      if (kind === 'diff') diffReady = true; // align always false
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

  diffW.onerror  = (err) => { const e = new Error('Diff worker crashed'); for (const v of pending.values()) if (v.kind==='diff') v.reject(e); };

  const sendDiff = (base, current, options) => {
    if (!diffReady) return Promise.reject(new Error('Diff worker not ready'));
    const id = msgId++;
    // Pass baseline atomically with the diff request to avoid races
    const payload = { id, type: 'diff', baselineText: base, text: current, options };
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject, kind: 'diff' }); diffW.postMessage(payload); });
  };
  const setDiffBaseline = (baselineText) => { diffW.postMessage({ type: 'setBaseline', baselineText }); };

  const terminateAll = () => {
    try { diffW.terminate(); } catch {}
    for (const { reject } of pending.values()) reject(new Error('Workers terminated'));
    pending.clear();
  };

  return {
    diff:  { send: sendDiff, setBaseline: setDiffBaseline },
    terminateAll,
    isReady: () => diffReady,
    diffReady: () => diffReady,
    alignReady: () => false,
  };
}
