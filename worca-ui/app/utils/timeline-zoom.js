export const SCALE_MIN = 1.0;
export const SCALE_MAX = 32;

export function clampScale(scale) {
  return Math.max(SCALE_MIN, Math.min(SCALE_MAX, scale));
}

// panMs is bounded to [0, totalMs - totalMs/scale]
export function clampPan(panMs, totalMs, scale) {
  const visibleMs = totalMs / scale;
  const maxPan = Math.max(0, totalMs - visibleMs);
  return Math.max(0, Math.min(maxPan, panMs));
}

export function resetZoom() {
  return { scale: 1.0, panMs: 0 };
}

// Wheel-anchored zoom: the time under the cursor stays fixed after scale change.
// deltaY > 0 = zoom out, deltaY < 0 = zoom in.
// cursorMs: time coordinate under the cursor (in ms from run start)
export function wheelZoom(state, deltaY, cursorMs, totalMs) {
  const factor = deltaY < 0 ? 2 : 0.5;
  const newScale = clampScale(state.scale * factor);
  if (newScale === state.scale) {
    return state;
  }
  // Fraction of the visible window at which the cursor sits
  const visibleMs = totalMs / state.scale;
  const cursorFraction =
    visibleMs > 0 ? (cursorMs - state.panMs) / visibleMs : 0;
  const newPanMs = clampPan(
    cursorMs - cursorFraction * (totalMs / newScale),
    totalMs,
    newScale,
  );
  return { scale: newScale, panMs: newPanMs };
}

// Drag-to-zoom: fit the [selStart, selEnd] window into the full view.
export function dragToZoom(state, selStart, selEnd, totalMs) {
  const lo = Math.min(selStart, selEnd);
  const hi = Math.max(selStart, selEnd);
  const windowMs = hi - lo;
  if (windowMs <= 0) {
    return state;
  }
  const newScale = clampScale(totalMs / windowMs);
  const newPanMs = clampPan(lo, totalMs, newScale);
  return { scale: newScale, panMs: newPanMs };
}
