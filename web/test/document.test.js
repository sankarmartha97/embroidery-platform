import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { heartDocument } from '../../test/helpers/documents.js';
import {
  hoopOf,
  inSequence,
  moveInSequence,
  nudge,
  objectBounds,
  setStitchType,
  updateStitch,
} from '../lib/document.js';

describe('document helpers', () => {
  it('draws the machine hoop when there is one, else the canvas', () => {
    assert.deepEqual(hoopOf(heartDocument()), { w: 100, h: 100 });
    assert.deepEqual(
      hoopOf(
        heartDocument({ machineProfile: { format: 'PES', hoopWidthMm: 130, hoopHeightMm: 180 } }),
      ),
      { w: 130, h: 180 },
    );
  });

  it('computes bounds after the transform, following curves', () => {
    const [heart, line] = heartDocument().objects;
    const b = objectBounds(heart);
    assert.ok(b.x >= 30 && b.x < 31 && b.w > 38 && b.h > 45);
    assert.deepEqual(objectBounds({ ...line, transform: [1, 0, 0, 1, 5, -10] }), {
      x: 35,
      y: 70,
      w: 40,
      h: 0,
    });
    assert.equal(objectBounds({ ...line, geometry: { ...line.geometry, d: 'nope' } }), null);
  });

  it('reorders the sequence and renumbers 1..n, sharing unchanged objects', () => {
    const doc = heartDocument();
    const moved = moveInSequence(doc, 'underline', -1);
    assert.deepEqual(
      inSequence(moved).map((o) => [o.id, o.sequence]),
      [
        ['underline', 1],
        ['outline', 2],
      ],
    );
    assert.equal(moveInSequence(doc, 'outline', -1), doc, 'already first');
  });

  it('nudges by 0.1 mm without float drift and never moves locked objects', () => {
    let doc = heartDocument();
    for (let i = 0; i < 3; i++) doc = nudge(doc, 'underline', 0.1, 0);
    assert.deepEqual(doc.objects[1].transform, [1, 0, 0, 1, 0.3, 0]);
    const locked = { ...doc, objects: doc.objects.map((o) => ({ ...o, locked: true })) };
    assert.equal(nudge(locked, 'underline', 1, 1).objects[1], locked.objects[1]);
  });

  it('changes stitch type, keeping the thread and dropping foreign parameters', () => {
    const doc = updateStitch(heartDocument(), 'underline', { stitchLengthMm: 3 });
    const filled = setStitchType(doc, 'underline', 'fill');
    assert.deepEqual(filled.objects[1].stitch, { type: 'fill', threadId: 't2' });
    assert.equal(filled.objects[0], doc.objects[0], 'other objects shared');
  });
});
