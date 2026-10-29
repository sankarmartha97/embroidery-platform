import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { heartDocument } from '../../test/helpers/documents.js';
import { FakeEngine } from '../../workers/engines/fake/fake-engine.js';
import {
  advance,
  boundary,
  buildPlayback,
  clock,
  objectNear,
  positionOf,
  progressAt,
  speedAt,
} from '../lib/simulator.js';

const CANVAS = { width: 100, height: 100 };
const data = {
  threads: [
    { index: 0, hex: '#CC3344' },
    { index: 1, hex: '#2244AA' },
  ],
  commands: [
    ['stitch', 0, 0],
    ['stitch', 20, 0],
    ['trim'],
    ['color_change', 1],
    ['jump', 100, 100],
    ['stitch', 100, 100],
    ['stitch', 120, 100],
    ['end'],
  ],
  objectMap: [
    { objectId: 'a', fromCommand: 0, toCommand: 2 },
    { objectId: 'b', fromCommand: 3, toCommand: 6 },
  ],
};

describe('simulator playback', () => {
  it('maps stitch data to canvas mm, kinds, colours and objects', () => {
    const p = buildPlayback(data, CANVAS);
    assert.equal(p.count, 7); // 'end' dropped
    assert.deepEqual([...p.x], [50, 52, 52, 52, 60, 60, 62]);
    assert.deepEqual([...p.y], [50, 50, 50, 50, 60, 60, 60]);
    assert.deepEqual([...p.kind], [0, 0, 2, 3, 1, 0, 0]);
    assert.deepEqual([...p.colour], [0, 0, 0, 1, 1, 1, 1]);
    assert.deepEqual([...p.object], [0, 0, 0, 1, 1, 1, 1]);
    assert.deepEqual(p.objectIds, ['a', 'b']);
    assert.deepEqual(p.threads, ['#CC3344', '#2244AA']);
    assert.deepEqual(p.blocks, [
      { colour: 0, from: 0, to: 2 },
      { colour: 1, from: 3, to: 6 },
    ]);
    assert.deepEqual(p.stats, { stitches: 4, jumps: 1, trims: 1, colorChanges: 1 });
  });

  it('steps between objects and colours both ways', () => {
    const p = buildPlayback(data, CANVAS);
    assert.equal(boundary(p, 0, 1, 'object'), 3);
    assert.equal(boundary(p, 3, 1, 'object'), 6); // last object: to the end
    assert.equal(boundary(p, 5, -1, 'colour'), 3); // back to the start of this block
    assert.equal(boundary(p, 3, -1, 'colour'), 0); // already at its start: previous block
    assert.equal(boundary(p, 0, -1, 'colour'), 0);
  });

  it('advances by speed with a carried fraction, on a log speed scale', () => {
    assert.deepEqual(advance(0, 16, 100), { steps: 1, carry: 0.6000000000000001 });
    assert.equal(advance(0.6, 16, 100).steps, 2);
    assert.equal(speedAt(0), 1);
    assert.equal(speedAt(1), 1000);
    assert.equal(speedAt(positionOf(100)), 100);
  });

  it('counts sewn stitches, time, and finds the object under a click', () => {
    const p = buildPlayback(data, CANVAS);
    assert.deepEqual(progressAt(p, 6), { sewn: 4, seconds: 0 });
    assert.equal(clock(125), '2:05');
    assert.equal(objectNear(p, [61.5, 60.2], 1), 'b');
    assert.equal(objectNear(p, [61.5, 60.2], 1, 4), null); // not sewn yet at step 4
    assert.equal(objectNear(p, [90, 90], 1), null);
  });

  it('reads what the engine produces', async () => {
    const doc = heartDocument();
    const stitchData = await new FakeEngine().generateStitches(doc);
    const p = buildPlayback(stitchData, doc.canvas);
    assert.equal(p.stats.stitches, stitchData.stats.stitches);
    assert.deepEqual(p.objectIds, ['outline', 'underline']);
    // Every stitch lands inside the canvas.
    for (let i = 0; i < p.count; i++) {
      assert.ok(p.x[i] >= 0 && p.x[i] <= 100 && p.y[i] >= 0 && p.y[i] <= 100);
    }
  });
});
