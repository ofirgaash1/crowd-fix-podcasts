// v2/ui/toast.js
export function showToast(message, type = 'info', ms = 2500) {
  try {
    // Also log toast messages for debugging/telemetry in v2 stack
    try {
      const tag = type === 'error' ? '[toast:error]' : type === 'success' ? '[toast:success]' : '[toast]';
      // eslint-disable-next-line no-console
      console.log(`${tag} ${String(message || '')}`);
    } catch {}
    let cont = document.getElementById('toastContainer');
    if (!cont) {
      cont = document.createElement('div');
      cont.id = 'toastContainer';
      cont.className = 'toast-container';
      cont.setAttribute('aria-live', 'polite');
      cont.setAttribute('aria-atomic', 'true');
      document.body.appendChild(cont);
    }
    const div = document.createElement('div');
    div.className = `toast ${type}`;
    div.textContent = String(message || '');
    cont.appendChild(div);
    setTimeout(() => { div.remove(); }, ms);
  } catch {}
}

