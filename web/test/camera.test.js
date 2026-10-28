import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  actualSize,
  easeInOut,
  fit,
  frame,
  gridLevels,
  lerpCamera,
  MAX_SCALE,
  pan,
  PX_PER_MM,
  rulerTicks,
  toScreen,
  toWorld,
  zoomAt,
} from '../lib/camera.js';

const close = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`);

describe('camera', () => {
  it('converts between screen px and mm both ways', () => {
    const cam = { scale: 4, x: 100, y: 50 };
    assert.deepEqual(toScreen(cam, [10, 20]), [140, 130]);
    assert.deepEqual(toWorld(cam, [140, 130]), [10, 20]);
  });

  it('zooms to the cursor: the point under the cursor stays put', () => {
    const cam = { scale: 3, x: 40, y: 30 };
    const under = toWorld(cam, [250, 175]);
    const zoomed = zoomAt(cam, 1.5, 250, 175);
    assert.equal(zoomed.scale, 4.5);
    const [sx, sy] = toScreen(zoomed, under);
    close(sx, 250);
    close(sy, 175);
  });

  it('clamps zoom', () => {
    assert.equal(zoomAt({ scale: 150, x: 0, y: 0 }, 10, 0, 0).scale, MAX_SCALE);
  });

  it('fits the hoop centred with padding', () => {
    const cam = fit(1000, 600, { x: 0, y: 0, w: 100, h: 100 }, 50);
    assert.equal(cam.scale, 5); // (600 - 100) / 100
    assert.deepEqual(toScreen(cam, [50, 50]), [500, 300]);
  });

  it('shows actual size at 96 dpi', () => {
    const cam = actualSize(800, 600, [50, 50]);
    assert.equal(cam.scale, PX_PER_MM);
    assert.deepEqual(toScreen(cam, [50, 50]), [400, 300]);
  });

  it('pans by screen pixels', () => {
    assert.deepEqual(pan({ scale: 2, x: 1, y: 2 }, 10, -5), { scale: 2, x: 11, y: -3 });
  });

  it('hides grid lines that would be too dense', () => {
    assert.deepEqual(gridLevels(8), { minor: true, major: true });
    assert.deepEqual(gridLevels(2), { minor: false, major: true });
    assert.deepEqual(gridLevels(0.3), { minor: false, major: false });
  });

  it('places ruler ticks at mm positions with adaptive spacing', () => {
    const cam = { scale: 10, x: 25, y: 0 };
    const ticks = rulerTicks(cam, 'x', 130);
    assert.deepEqual(
      ticks.map((t) => t.mm),
      [-2, -1, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
    );
    assert.deepEqual(
      ticks.filter((t) => t.major).map((t) => t.mm),
      [0, 10],
    );
    assert.equal(ticks.find((t) => t.mm === 0).px, 25);
    const far = rulerTicks({ scale: 0.5, x: 0, y: 0 }, 'x', 100);
    assert.deepEqual(
      far.map((t) => t.mm),
      [0, 50, 100, 150, 200],
    );
  });

  it('frames an object, keeping tiny objects and lines at a readable size', () => {
    const big = frame(800, 600, { x: 0, y: 0, w: 100, h: 50 });
    assert.deepEqual(big, fit(800, 600, { x: 0, y: 0, w: 100, h: 50 }));
    const line = frame(800, 600, { x: 30, y: 80, w: 4, h: 0 });
    assert.deepEqual(line, fit(800, 600, { x: 22, y: 70, w: 20, h: 20 }));
    const [cx, cy] = toWorld(line, [400, 300]);
    close(cx, 32);
    close(cy, 80);
  });

  it('glides between cameras: ends exactly, eases, and zooms evenly in log space', () => {
    const a = { scale: 2, x: 0, y: 0 };
    const b = { scale: 8, x: -500, y: -300 };
    assert.deepEqual(lerpCamera(a, b, 0, 800, 600), a);
    const end = lerpCamera(a, b, 1, 800, 600);
    close(end.scale, b.scale);
    close(end.x, b.x);
    close(end.y, b.y);
    close(lerpCamera(a, b, 0.5, 800, 600).scale, 4);
    close(easeInOut(0.5), 0.5);
    assert.ok(easeInOut(0.1) < 0.1 && easeInOut(0.9) > 0.9);
    assert.deepEqual(lerpCamera(a, b, 7, 800, 600), end);
  });
});
