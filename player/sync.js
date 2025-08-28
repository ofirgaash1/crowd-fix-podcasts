// v2/player/sync.js
// Keep the global store's playback state in sync with the <audio> element.
// - Uses requestAnimationFrame for smooth ticks while playing.
// - Publishes only when values actually change to avoid subscriber storms.
// - Listens for CustomEvent('v2:seek', {detail:{time}}) on an optional target
//   (e.g., the transcript container) to jump the player without auto-playing.

import { store } from '../core/state.js';

/** Small helpers */
const nearlyEqual = (a, b, eps = 1e-3) =>
  Math.abs((+a || 0) - (+b || 0)) <= eps;

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

/**
 * @typedef {Object} SetupOptions
 * @property {HTMLElement} [seekTarget] - element to listen on for 'v2:seek' (e.g., transcript root)
 * @property {boolean} [playOnSeek=false] - if true, resume playback after seek
 * @property {number}  [publishHz=60] - max publish frequency (frames/sec)
 */

/**
 * Wire an <audio> to the global store.
 * @param {HTMLMediaElement} audioEl
 * @param {SetupOptions} [opts]
 * @returns {{ destroy():void, seekTo(t:number):void, setRate(x:number):void, setPlaying(on:boolean):void }}
 */
export function setupPlayerSync(audioEl, opts = {}) {
  if (!audioEl || typeof audioEl.play !== 'function') {
    throw new Error('setupPlayerSync: valid HTMLMediaElement is required');
  }

  const seekTarget = opts.seekTarget || null;
  const playOnSeek = !!opts.playOnSeek;
  const publishHz = Math.max(15, Math.min(120, opts.publishHz || 60));
  const minFrameMs = 1000 / publishHz;

  let rafId = 0;
  let lastPublishTs = 0;
  let last = {
    t: -1,
    rate: NaN,
    paused: !audioEl || audioEl.paused
  };

  /** Push a partial playback state if something changed */
  function publish(nowTs) {
    const t = clamp(audioEl.currentTime || 0, 0, Number.MAX_SAFE_INTEGER);
    const rate = +audioEl.playbackRate || 1;
    const paused = !!(audioEl.paused || audioEl.ended);

    // Budget: cap to publishHz; also avoid publishing identical values
    if (nowTs != null && nowTs - lastPublishTs < minFrameMs) return;

    const changed =
      !nearlyEqual(t, last.t, 1e-3) ||
      !nearlyEqual(rate, last.rate, 1e-3) ||
      paused !== last.paused;

    if (!changed) return;

    lastPublishTs = nowTs || performance.now();
    last.t = t;
    last.rate = rate;
    last.paused = paused;

    store.setState(
      {
        playback: {
          currentTime: t,
          rate,
          paused
        }
      },
      'playback:tick'
    );
  }

  /** rAF loop while playing */
  function tick(now) {
    publish(now);
    if (!audioEl.paused && !audioEl.ended) {
      rafId = requestAnimationFrame(tick);
    } else {
      rafId = 0;
    }
  }

  /** Immediate one-shot publish (e.g., on seeked/ratechange) */
  function flush() {
    publish(performance.now());
  }

  /** Public controls */
  function seekTo(t) {
    try {
      const target = clamp(+t || 0, 0, audioEl.duration || Number.MAX_SAFE_INTEGER);
      audioEl.currentTime = target;
      flush();
      if (playOnSeek && audioEl.paused) audioEl.play().catch(() => {});
    } catch { /* noop */ }
  }
  function setRate(x) {
    const r = +x || 1;
    if (!nearlyEqual(audioEl.playbackRate, r, 1e-3)) {
      audioEl.playbackRate = r;
      flush();
    }
  }
  function setPlaying(on) {
    if (on) {
      audioEl.play?.().then(() => { if (!rafId) rafId = requestAnimationFrame(tick); }).catch(() => {});
    } else {
      audioEl.pause?.();
      flush();
    }
  }

  /* ========== DOM Event Wiring ========== */

  // Start/stop rAF loop with play/pause/ended
  const onPlay = () => {
    // ensure we publish new paused=false immediately
    flush();
    if (!rafId) rafId = requestAnimationFrame(tick);
  };
  const onPause = () => {
    flush();
    if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
  };
  const onEnded = onPause;

  // Keep rate synced
  const onRateChange = () => flush();

  // Seek updates (these events may be noisy, flush once here; rAF will take over if playing)
  const onSeeking = () => flush();
  const onSeeked  = () => flush();

  // Fallback updates (some browsers fire timeupdate ~4–5Hz)
  const onTimeUpdate = () => publish(performance.now());

  // Media attachment
  audioEl.addEventListener('play', onPlay);
  audioEl.addEventListener('pause', onPause);
  audioEl.addEventListener('ended', onEnded);
  audioEl.addEventListener('ratechange', onRateChange);
  audioEl.addEventListener('seeking', onSeeking);
  audioEl.addEventListener('seeked', onSeeked);
  audioEl.addEventListener('timeupdate', onTimeUpdate);

  // Optional: listen to transcript’s custom seek requests
  const onExternalSeek = (e) => {
    const detail = e?.detail || {};
    if (typeof detail.time === 'number') seekTo(detail.time);
  };
  if (seekTarget) {
    seekTarget.addEventListener('v2:seek', onExternalSeek);
  }

  // Initialize store once with current values
  flush();

  return {
    destroy() {
      if (rafId) { cancelAnimationFrame(rafId); rafId = 0; }
      audioEl.removeEventListener('play', onPlay);
      audioEl.removeEventListener('pause', onPause);
      audioEl.removeEventListener('ended', onEnded);
      audioEl.removeEventListener('ratechange', onRateChange);
      audioEl.removeEventListener('seeking', onSeeking);
      audioEl.removeEventListener('seeked', onSeeked);
      audioEl.removeEventListener('timeupdate', onTimeUpdate);
      if (seekTarget) seekTarget.removeEventListener('v2:seek', onExternalSeek);
    },
    seekTo,
    setRate,
    setPlaying
  };
}
