import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { readMachineFile } from '../../tools/format-harness/index.js';
import { writeDst } from '../../workers/engines/fake/dst-writer.js';
import { FakeEngine } from '../../workers/engines/fake/fake-engine.js';

const document = {
  schemaVersion: 1,
  units: 'mm',
  canvas: { width: 100, height: 100 },
  threads: [
    { id: 't1', hex: '#CC3344' },
    { id: 't2', hex: '#2255AA' },
  ],
  objects: [
    {
      id: 'square',
      type: 'embroidery-path',
      geometry: { kind: 'path', d: 'M20 20 L80 20 L80 80 L20 80', closed: true },
      stitch: { type: 'running', threadId: 't1', stitchLengthMm: 2.5 },
      sequence: 1,
    },
    {
      id: 'line',
      type: 'embroidery-path',
      geometry: { kind: 'path', d: 'M10 50 L90 50', closed: false },
      stitch: { type: 'running', threadId: 't2' },
      sequence: 2,
    },
  ],
};
const profile = { hoopWidthMm: 100, hoopHeightMm: 100, maxStitchLengthMm: 12.1 };
const sha = (v) =>
  createHash('sha256')
    .update(typeof v === 'string' ? v : JSON.stringify(v))
    .digest('hex');

describe('FakeEngine', () => {
  const engine = new FakeEngine();

  it('is deterministic: same input, same stitch data (SHA-256)', async () => {
    const a = await engine.generateStitches(document);
    const b = await engine.generateStitches(document);
    assert.equal(sha(a), sha(b));
  });

  it('produces stitch-data format v1 with stats, bounds and an object map', async () => {
    const data = await engine.generateStitches(document);
    assert.equal(data.format, 'emb-stitch-data');
    assert.equal(data.units, '0.1mm');
    assert.equal(data.stats.colorChanges, 1);
    assert.equal(data.stats.jumps, 1);
    assert.deepEqual(data.bounds, { minX: -400, minY: -300, maxX: 400, maxY: 300 });
    assert.deepEqual(
      data.objectMap.map((o) => o.objectId),
      ['square', 'line'],
    );
    assert.deepEqual(data.commands.at(-1), ['end']);
  });

  it('passes validation inside the hoop and fails when the design is outside it', async () => {
    const data = await engine.generateStitches(document);
    assert.equal((await engine.validate(data, profile)).status, 'passed');
    const small = await engine.validate(data, { ...profile, hoopWidthMm: 60 });
    assert.equal(small.status, 'failed');
    assert.deepEqual(
      small.issues.map((i) => i.code),
      ['OUT_OF_HOOP'],
    );
  });

  it('flags empty designs and missing threads', async () => {
    const empty = await engine.generateStitches({ ...document, objects: [] });
    assert.equal((await engine.validate(empty, profile)).issues[0].code, 'EMPTY_DESIGN');
    const broken = {
      ...document,
      objects: [{ ...document.objects[0], stitch: { type: 'running', threadId: 'nope' } }],
    };
    await assert.rejects(engine.generateStitches(broken), { code: 'INVALID_DOCUMENT' });
  });

  it('honours an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(engine.generateStitches(document, { signal: controller.signal }), {
      code: 'CANCELLED',
    });
  });
});

describe('machine files read back by the independent harness', () => {
  const engine = new FakeEngine();

  for (const format of ['DST', 'JEF']) {
    it(`${format}: counts and extents match the stitch data`, async () => {
      const data = await engine.generateStitches(document);
      const { buffer } = await engine.exportMachineFile(data, format, profile);
      const read = readMachineFile(buffer, format.toLowerCase());
      assert.deepEqual(read.warnings, []);
      assert.equal(read.ended, true);
      assert.equal(read.stitches, data.stats.stitches);
      assert.equal(read.colorChanges, data.stats.colorChanges);
      assert.deepEqual(read.extents, data.bounds);
      assert.equal(read.widthMm, 80);
      assert.equal(read.heightMm, 60);
    });
  }

  it('DST: every step from -121 to 121 on both axes round-trips', () => {
    for (let v = -121; v <= 121; v++) {
      const data = {
        bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
        commands: [['stitch', 0, 0], ['stitch', v, -v], ['end']],
      };
      const read = readMachineFile(writeDst(data), 'dst');
      assert.deepEqual(
        [read.extents.maxX - read.extents.minX, read.extents.maxY - read.extents.minY],
        [Math.abs(v), Math.abs(v)],
      );
    }
  });

  it('DST: moves longer than 12.1 mm are split into jumps', async () => {
    const data = {
      bounds: { minX: 0, minY: 0, maxX: 500, maxY: 0 },
      commands: [['stitch', 0, 0], ['stitch', 500, 0], ['end']],
    };
    const read = readMachineFile(writeDst(data), 'dst');
    assert.equal(read.stitches, 2);
    assert.equal(read.jumps, 4); // 4 × 121 = 484, then a 16-unit stitch
    assert.equal(read.extents.maxX, 500);
  });

  it('rejects formats it cannot read', () => {
    assert.throws(() => readMachineFile(Buffer.alloc(10), 'pes'), /No reader/);
  });
});

describe('harness against independent reference files (pyembroidery)', () => {
  for (const ext of ['dst', 'jef']) {
    it(`${ext}: matches the values pyembroidery reports`, async () => {
      const { readFile } = await import('node:fs/promises');
      const buffer = await readFile(
        new URL(`../fixtures/reference/ellipse-zigzag-line.${ext}`, import.meta.url),
      );
      const read = readMachineFile(buffer, ext);
      assert.equal(read.stitches, 119);
      assert.equal(read.colorChanges, 2);
      assert.deepEqual(read.extents, { minX: -350, minY: -250, maxX: 350, maxY: 230 });
      assert.deepEqual(read.warnings, []);
    });
  }
});
