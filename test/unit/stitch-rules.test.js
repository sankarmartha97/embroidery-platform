// S6-01 done-when: a unit test per rule; issues carry object ids.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { validateStitchData } from '../../workers/validation/stitch-rules.js';

const PROFILE = { hoopWidthMm: 100, hoopHeightMm: 100, maxStitchLengthMm: 12.1 };

/** Stitch data from commands; objects = [[objectId, fromCommand, toCommand], ...]. */
function data(commands, objects = [['a', 0, commands.length - 1]]) {
  const colorChanges = commands.filter(([t]) => t === 'color_change').length;
  return {
    format: 'emb-stitch-data',
    version: 1,
    commands: [...commands, ['end']],
    objectMap: objects.map(([objectId, fromCommand, toCommand]) => ({
      objectId,
      fromCommand,
      toCommand,
    })),
    stats: { colorChanges },
  };
}
const run = (n, { x = 0, step = 20 } = {}) =>
  Array.from({ length: n }, (_, i) => ['stitch', x + i * step, 0]);
const codes = (result) => result.issues.map((i) => i.code);

describe('validateStitchData', () => {
  it('passes a clean design', () => {
    assert.deepEqual(validateStitchData(data(run(10)), PROFILE), { status: 'passed', issues: [] });
  });

  it('EMPTY_DESIGN: no stitches is an error', () => {
    const result = validateStitchData(data([], []), PROFILE);
    assert.equal(result.status, 'failed');
    assert.deepEqual(codes(result), ['EMPTY_DESIGN']);
  });

  it('OUT_OF_HOOP: stitches beyond half the hoop, with the objects named', () => {
    const commands = [...run(3), ['stitch', 499, 0], ['stitch', 501, 0], ['stitch', 0, -600]];
    const result = validateStitchData(
      data(commands, [
        ['inside', 0, 3],
        ['wide', 4, 4],
        ['tall', 5, 5],
      ]),
      PROFILE,
    );
    const issue = result.issues.find((i) => i.code === 'OUT_OF_HOOP');
    assert.equal(issue.severity, 'error');
    assert.equal(issue.count, 2);
    assert.deepEqual(issue.objectIds, ['wide', 'tall']);
  });

  it('OUT_OF_HOOP: honours the hoop margin', () => {
    const commands = run(25); // 2 mm steps out to x = 48 mm, 2 mm inside a 100 mm hoop
    assert.equal(validateStitchData(data(commands), PROFILE).status, 'passed');
    const tight = validateStitchData(data(commands), { ...PROFILE, hoopMarginMm: 3 });
    assert.deepEqual(codes(tight), ['OUT_OF_HOOP']);
  });

  it('STITCH_TOO_LONG: an error, or a warning when the writer splits long stitches', () => {
    const commands = [
      ['stitch', 0, 0],
      ['stitch', 122, 0],
      ['stitch', 140, 0],
    ];
    const strict = validateStitchData(data(commands), PROFILE);
    assert.deepEqual(strict.issues, [
      {
        code: 'STITCH_TOO_LONG',
        severity: 'error',
        count: 1,
        objectIds: ['a'],
        message: 'Stitches longer than 12.1 mm',
      },
    ]);
    const split = validateStitchData(data(commands), PROFILE, { longStitchesSplit: true });
    assert.equal(split.status, 'warning');
  });

  it('STITCH_TOO_SHORT: a warning between penetrations, not after a jump', () => {
    const commands = [
      ['stitch', 0, 0],
      ['stitch', 2, 0], // 0.2 mm: too short
      ['jump', 200, 0],
      ['stitch', 200, 0], // needle-down where the jump landed: fine
      ['stitch', 220, 0],
    ];
    const result = validateStitchData(
      data(commands, [
        ['first', 0, 1],
        ['second', 2, 4],
      ]),
      PROFILE,
    );
    assert.equal(result.status, 'warning');
    const issue = result.issues.find((i) => i.code === 'STITCH_TOO_SHORT');
    assert.equal(issue.count, 1);
    assert.deepEqual(issue.objectIds, ['first']);
  });

  it('TOO_MANY_COLORS: colour blocks beyond the machine maximum', () => {
    const commands = [
      ...run(2),
      ['color_change', 1],
      ...run(2, { x: 100 }),
      ['color_change', 2],
      ...run(2, { x: 200 }),
    ];
    assert.equal(validateStitchData(data(commands), { ...PROFILE, maxColors: 3 }).status, 'passed');
    const result = validateStitchData(data(commands), { ...PROFILE, maxColors: 2 });
    assert.deepEqual(codes(result), ['TOO_MANY_COLORS']);
    assert.equal(result.issues[0].count, 3);
  });

  it('MISSING_TRIM: a long jump run without a trim, where the profile asks for one', () => {
    const untrimmed = [
      ...run(2),
      ['jump', 100, 0],
      ['jump', 200, 0], // 18 mm of jumps in one run
      ...run(2, { x: 200 }),
    ];
    const profile = { ...PROFILE, trimJumpThresholdMm: 7 };
    const result = validateStitchData(
      data(untrimmed, [
        ['a', 0, 1],
        ['b', 2, 5],
      ]),
      profile,
    );
    assert.deepEqual(result.issues, [
      {
        code: 'MISSING_TRIM',
        severity: 'warning',
        count: 1,
        objectIds: ['b'],
        message: 'Jumps longer than 7 mm without a trim',
      },
    ]);

    const trimmed = [
      ...run(2),
      ['trim'],
      ['jump', 100, 0],
      ['jump', 200, 0],
      ...run(2, { x: 200 }),
    ];
    assert.equal(validateStitchData(data(trimmed), profile).status, 'passed');
    assert.equal(
      validateStitchData(data(untrimmed), PROFILE).status,
      'passed',
      'no threshold, no rule',
    );
  });

  it('reports every failing rule together, errors first', () => {
    const commands = [
      ['stitch', 0, 0],
      ['stitch', 1, 0],
      ['stitch', 900, 0],
    ];
    const result = validateStitchData(data(commands), PROFILE);
    assert.equal(result.status, 'failed');
    assert.deepEqual(codes(result), ['OUT_OF_HOOP', 'STITCH_TOO_LONG', 'STITCH_TOO_SHORT']);
  });
});
