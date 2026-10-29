import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { objectBounds } from '../lib/document.js';
import {
  apply,
  dragTransform,
  handlePoints,
  IDENTITY,
  invert,
  keepInCanvas,
  localBounds,
  multiply,
  rotationOf,
  tidy,
} from '../lib/transform.js';

const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);
const closePoint = (p, q, eps = 1e-3) => p.forEach((v, i) => close(v, q[i], eps));
// A 20 × 10 mm rectangle at (10, 10).
const rect = {
  id: 'r',
  geometry: { d: 'M 10 10 L 30 10 L 30 20 L 10 20 Z', closed: true },
  transform: IDENTITY,
};
const bounds = localBounds(rect);
const drag = (handle, from, to, extra = {}) =>
  dragTransform({ matrix: IDENTITY, bounds, handle, from, to, ...extra });
const boundsAfter = (matrix) => objectBounds({ ...rect, transform: matrix });

describe('transform matrices', () => {
  it('multiplies, applies and inverts', () => {
    const m = [2, 0, 0, 3, 5, 7];
    closePoint(apply(m, [1, 1]), [7, 10]);
    closePoint(apply(multiply(invert(m), m), [4, -2]), [4, -2]);
    assert.deepEqual(tidy([1.000004, -0.00001, 0, 1, 1.23456, -0.0001]), [1, 0, 0, 1, 1.235, 0]);
  });

  it('places 8 handles on the local box', () => {
    const h = handlePoints(bounds);
    assert.deepEqual(h.nw, [10, 10]);
    assert.deepEqual(h.e, [30, 15]);
    assert.deepEqual(h.s, [20, 20]);
  });
});

describe('dragging handles', () => {
  it('moves, snapping to 0.1 mm', () => {
    assert.deepEqual(drag('move', [0, 0], [3.04, -1.26]), [1, 0, 0, 1, 3, -1.3]);
  });

  it('scales from the opposite handle, one axis for edges', () => {
    const wider = drag('e', [30, 15], [40, 99]);
    assert.deepEqual(boundsAfter(wider), { x: 10, y: 10, w: 30, h: 10 });
    const corner = drag('se', [30, 20], [50, 30]);
    assert.deepEqual(boundsAfter(corner), { x: 10, y: 10, w: 40, h: 20 });
    const fromTop = drag('n', [20, 10], [20, 0]);
    assert.deepEqual(boundsAfter(fromTop), { x: 10, y: 0, w: 20, h: 20 });
  });

  it('keeps proportions with Shift and scales from the centre with Alt', () => {
    const even = boundsAfter(drag('se', [30, 20], [50, 22], { shift: true }));
    close(even.w / even.h, 2);
    close(even.w, 40);
    const centred = boundsAfter(drag('e', [30, 15], [35, 15], { alt: true }));
    assert.deepEqual(centred, { x: 5, y: 10, w: 30, h: 10 });
  });

  it('never collapses an object to zero size', () => {
    const flat = boundsAfter(drag('e', [30, 15], [10, 15]));
    assert.ok(flat.w > 0);
  });

  it('rotates about the centre, snapping to 15° with Shift', () => {
    // From the right of the centre (20, 15) to below it: +90°.
    const quarter = drag('rotate', [30, 15], [20, 25]);
    close(rotationOf(quarter), 90, 1e-3);
    closePoint(apply(quarter, [20, 15]), [20, 15]);
    const b = boundsAfter(quarter);
    close(b.w, 10, 1e-3);
    close(b.h, 20, 1e-3);
    const snapped = drag('rotate', [30, 15], [30, 17], { shift: true }); // ~11°
    close(rotationOf(snapped), 15, 1e-3);
  });

  it('scales a rotated object along its own axes', () => {
    const rotated = drag('rotate', [30, 15], [20, 25]); // 90°: local x now points down
    const longer = dragTransform({
      matrix: rotated,
      bounds,
      handle: 'e',
      from: apply(rotated, [30, 15]),
      to: apply(rotated, [40, 15]),
    });
    const b = boundsAfter(longer);
    close(b.h, 30, 1e-3);
    close(b.w, 10, 1e-3);
  });
});

describe('canvas limits', () => {
  const canvas = { width: 100, height: 100 };
  it('pulls a move back inside the canvas', () => {
    const outside = drag('move', [0, 0], [-15, 85]);
    assert.deepEqual(boundsAfter(keepInCanvas(rect, outside, canvas, 'move')), {
      x: 0,
      y: 90,
      w: 20,
      h: 10,
    });
    assert.deepEqual(keepInCanvas(rect, IDENTITY, canvas, 'move'), IDENTITY);
  });

  it('refuses a scale that leaves the canvas', () => {
    assert.equal(keepInCanvas(rect, drag('se', [30, 20], [130, 20]), canvas, 'se'), null);
  });
});
