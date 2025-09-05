// v2/ui/toast.js
export function showToast(message, type = 'info', ms = 2500) {
  try {
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

