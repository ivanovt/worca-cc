import { describe, expect, it } from 'vitest';
import {
  clampPan,
  clampScale,
  dragToZoom,
  resetZoom,
  wheelZoom,
} from './timeline-zoom.js';

const SCALE_MIN = 1.0;
const SCALE_MAX = 32;

describe('clampScale', () => {
  it('clamps below min to 1.0', () => {
    expect(clampScale(0.5)).toBe(SCALE_MIN);
  });

  it('clamps above max to 32', () => {
    expect(clampScale(64)).toBe(SCALE_MAX);
  });

  it('passes through a value within range', () => {
    expect(clampScale(4)).toBe(4);
  });
});

describe('clampPan', () => {
  it('clamps pan below 0 to 0', () => {
    expect(clampPan(-100, 5000, 2.0)).toBe(0);
  });

  it('clamps pan beyond run window', () => {
    // totalMs=10000, scale=2 → visible window = 10000/2 = 5000
    // max panMs = 10000 - 5000 = 5000
    expect(clampPan(9000, 10000, 2.0)).toBe(5000);
  });

  it('returns 0 when scale is 1 (fit-to-run)', () => {
    expect(clampPan(500, 10000, 1.0)).toBe(0);
  });

  it('passes through valid pan', () => {
    expect(clampPan(2000, 10000, 4.0)).toBe(2000);
  });
});

describe('resetZoom', () => {
  it('returns scale=1.0 and panMs=0', () => {
    const state = resetZoom();
    expect(state.scale).toBe(1.0);
    expect(state.panMs).toBe(0);
  });
});

describe('wheelZoom', () => {
  it('zooms in (negative deltaY) and anchors the cursor time', () => {
    // At scale=1, panMs=0, totalMs=10000, cursor at 50% → cursorMs=5000
    // zoom in → scale doubles to 2
    // anchor: panMs adjusted so time under cursor stays
    // new panMs = cursorMs - cursorMs/newScale = 5000 - 5000/2 = 2500
    const state = { scale: 1.0, panMs: 0 };
    const next = wheelZoom(state, -1, 5000, 10000);
    expect(next.scale).toBe(2.0);
    expect(next.panMs).toBe(2500);
  });

  it('zooms out (positive deltaY) and anchors the cursor time', () => {
    // At scale=2, panMs=2500, totalMs=10000, cursorMs=5000
    // cursorFraction = (cursorMs - panMs) / (totalMs / scale) = (5000-2500)/(5000) = 0.5
    // zoom out → scale halves to 1
    // new panMs = cursorMs - cursorFraction * (totalMs / newScale) = 5000 - 0.5*10000 = 0
    const state = { scale: 2.0, panMs: 2500 };
    const next = wheelZoom(state, 1, 5000, 10000);
    expect(next.scale).toBe(1.0);
    expect(next.panMs).toBe(0);
  });

  it('does not zoom below scale=1.0', () => {
    const state = { scale: 1.0, panMs: 0 };
    const next = wheelZoom(state, 1, 5000, 10000);
    expect(next.scale).toBe(1.0);
    expect(next.panMs).toBe(0);
  });

  it('does not zoom above scale=32', () => {
    const state = { scale: 32, panMs: 0 };
    const next = wheelZoom(state, -1, 0, 10000);
    expect(next.scale).toBe(32);
  });

  it('cursor time at left edge: panMs stays at left edge after zoom in', () => {
    const state = { scale: 1.0, panMs: 0 };
    const next = wheelZoom(state, -1, 0, 10000);
    expect(next.panMs).toBe(0);
  });
});

describe('dragToZoom', () => {
  it('sets scale and panMs to fit the selected window', () => {
    // totalMs=10000, select [2000, 4000] → window of 2000ms
    // scale = totalMs / windowMs = 5
    // panMs = selStart = 2000
    const state = { scale: 1.0, panMs: 0 };
    const next = dragToZoom(state, 2000, 4000, 10000);
    expect(next.scale).toBe(5.0);
    expect(next.panMs).toBe(2000);
  });

  it('clamps scale to 32 for very small selections', () => {
    const state = { scale: 1.0, panMs: 0 };
    const next = dragToZoom(state, 0, 100, 10000);
    expect(next.scale).toBe(32);
  });

  it('handles reversed selection (selEnd < selStart)', () => {
    const state = { scale: 1.0, panMs: 0 };
    const next = dragToZoom(state, 4000, 2000, 10000);
    expect(next.scale).toBe(5.0);
    expect(next.panMs).toBe(2000);
  });
});
