// v2/ui/layout.js
// Scroll sync between panes and resizable gutters with persisted widths

export function setupScrollSync(els) {
  const trScroll = document.querySelector('#transcriptCard .body') || els.transcript;
  const diffScroll = document.querySelector('#diffCard .body') || els.diffBody;
  if (!trScroll || !diffScroll) return;

  let lock = 0;
  const sync = (src, dst) => {
    if (lock) return;
    lock = 1;
    const srcMax = Math.max(1, src.scrollHeight - src.clientHeight);
    const dstMax = Math.max(1, dst.scrollHeight - dst.clientHeight);
    dst.scrollTop = (src.scrollTop / srcMax) * dstMax;
    requestAnimationFrame(() => { lock = 0; });
  };

  trScroll.addEventListener('scroll', () => sync(trScroll, diffScroll), { passive: true });
  diffScroll.addEventListener('scroll', () => sync(diffScroll, trScroll), { passive: true });
}

const LS_W_NAV = 'v2:w:nav';
const LS_W_DIFF = 'v2:w:diff';

export function setupGutters(els) {
  const panel = els.panel, gutL = els.gutterL, gutR = els.gutterR;
  if (!panel || !gutL || !gutR) return;

  // restore saved widths
  const wNav = parseFloat(localStorage.getItem(LS_W_NAV));
  const wDiff = parseFloat(localStorage.getItem(LS_W_DIFF));
  if (Number.isFinite(wNav)) panel.style.setProperty('--w-nav', wNav + 'px');
  if (Number.isFinite(wDiff)) panel.style.setProperty('--w-diff', wDiff + 'px');

  let dragging = null;
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));

  function onMove(e) {
    if (!dragging) return;
    const x = e.clientX;
    if (dragging.which === 'L') {
      // left gutter controls DIFF width
      let newW;
      if (dragging.diffIsLeftOfGutter) {
        newW = clamp(x - dragging.panelRect.left, 220, 640);
      } else {
        newW = clamp(dragging.panelRect.right - x, 220, 640);
      }
      panel.style.setProperty('--w-diff', newW + 'px');
      try { localStorage.setItem(LS_W_DIFF, String(newW)); } catch {}
    } else {
      // right gutter controls NAV width
      let newW;
      if (dragging.browserIsRightOfGutter) {
        newW = clamp(dragging.panelRect.right - x, 240, 680);
      } else {
        newW = clamp(x - dragging.panelRect.left, 240, 680);
      }
      panel.style.setProperty('--w-nav', newW + 'px');
      try { localStorage.setItem(LS_W_NAV, String(newW)); } catch {}
    }
  }
  function stop() {
    if (!dragging) return;
    document.body.style.userSelect = dragging.prevUserSelect || '';
    dragging = null;
    window.removeEventListener('mousemove', onMove);
    window.removeEventListener('mouseup', stop);
  }
  function start(which, e) {
    const panelRect = panel.getBoundingClientRect();
    if (which === 'L') {
      const gutRect = els.gutterL.getBoundingClientRect();
      const diffRect = (els.diffCard || panel).getBoundingClientRect();
      dragging = {
        which, panelRect,
        prevUserSelect: document.body.style.userSelect,
        diffIsLeftOfGutter: diffRect.left < gutRect.left
      };
    } else {
      const gutRect = els.gutterR.getBoundingClientRect();
      const brRect = (els.browserCard || panel).getBoundingClientRect();
      dragging = {
        which, panelRect,
        prevUserSelect: document.body.style.userSelect,
        browserIsRightOfGutter: brRect.right > gutRect.right
      };
    }
    document.body.style.userSelect = 'none';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', stop);
  }

  gutL.addEventListener('mousedown', (e) => { e.preventDefault(); start('L', e); });
  gutR.addEventListener('mousedown', (e) => { e.preventDefault(); start('R', e); });

  // keyboard nudges (optional)
  function nudge(which, dx) {
    const cs = getComputedStyle(panel);
    const prop = which === 'L' ? '--w-diff' : '--w-nav';
    const cur = parseFloat(cs.getPropertyValue(prop)) || (which === 'L' ? 360 : 380);
    const next = (which === 'L') ? clamp(cur + dx, 220, 640) : clamp(cur + dx, 240, 680);
    panel.style.setProperty(prop, next + 'px');
    try { localStorage.setItem(which === 'L' ? LS_W_DIFF : LS_W_NAV, String(next)); } catch {}
  }
  gutL.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') nudge('L', -10);
    if (e.key === 'ArrowRight') nudge('L', 10);
  });
  gutR.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') nudge('R', -10);
    if (e.key === 'ArrowRight') nudge('R', 10);
  });
}

