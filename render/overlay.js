// v2/render/overlay.js
// Small, centralized DOM painters. Keeps Virtualizer focused on data & flow.

export function getCssVar(name, fallback = '') {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/**
 * Paints (or clears) probability background on a word <span>.
 * - Reads CSS vars: --prob-color (RGB triplet), --prob-alpha (0..1)
 * - Applies only if enabled && prob is finite && prob < threshold
 */
export function paintProbability(el, prob, enabled, threshold = 0.95) {
  if (!el) return;
  if (!enabled || !Number.isFinite(prob) || prob >= threshold) {
    el.style.backgroundColor = '';
    return;
  }
  const color = getCssVar('--prob-color', '255,235,59'); // RGB only
  const base = parseFloat(getCssVar('--prob-alpha', '0.6')) || 0.6;
  // Lower probability → stronger highlight
  const alpha = clamp01((1 - clamp01(prob)) * base);
  el.style.backgroundColor = `rgba(${color}, ${alpha})`;
}

export function setActive(el, on) {
  if (!el) return;
  if (on) el.classList.add('active');
  else el.classList.remove('active');
}

export function setConfirmed(el, on) {
  if (!el) return;
  if (on) el.classList.add('confirmed');
  else el.classList.remove('confirmed');
}

// ---------- utils ----------
function clamp01(v) { return Math.max(0, Math.min(1, v)); }
