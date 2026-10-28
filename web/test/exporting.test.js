import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { heartDocument } from '../../test/helpers/documents.js';
import {
  designBounds,
  hoopFit,
  nativeFormat,
  preExportCheck,
  stageLabel,
} from '../lib/exporting.js';

const FORMATS = [{ code: 'DST' }, { code: 'JEF' }, { code: 'PES' }];

describe('export dialog rules', () => {
  it('pre-selects the machine’s native format when it is enabled', () => {
    assert.equal(nativeFormat(FORMATS, { format: 'JEF' }), 'JEF');
    assert.equal(nativeFormat(FORMATS, { format: 'VP3' }), 'DST');
    assert.equal(nativeFormat(FORMATS, null), 'DST');
    assert.equal(nativeFormat([], { format: 'JEF' }), '');
  });

  it('measures the whole design and checks it against the hoop', () => {
    const bounds = designBounds(heartDocument());
    assert.ok(bounds.x >= 30 && bounds.x < 31);
    assert.ok(bounds.w > 38 && bounds.w <= 41);
    assert.equal(designBounds({ objects: [] }), null);

    const roomy = hoopFit(heartDocument(), { hoopWidthMm: 100, hoopHeightMm: 100 });
    assert.equal(roomy.fits, true);
    assert.equal(roomy.width, bounds.w);
    const small = hoopFit(heartDocument(), { hoopWidthMm: 20, hoopHeightMm: 100 });
    assert.equal(small.fits, false);
    assert.equal(hoopFit(heartDocument(), null), null);
    assert.equal(hoopFit({ objects: [] }, { hoopWidthMm: 1, hoopHeightMm: 1 }), null);
  });

  it('blocks on errors, asks to confirm warnings, and exports a clean report', () => {
    const issue = (severity) => ({ code: 'X', severity });
    assert.deepEqual(preExportCheck({ issues: [issue('error'), issue('warning')] }), {
      errors: 1,
      warnings: 1,
      decision: 'blocked',
    });
    assert.equal(preExportCheck({ issues: [issue('warning')] }).decision, 'confirm');
    assert.equal(preExportCheck({ status: 'passed', issues: [] }).decision, 'export');
  });

  it('names the stage of each job', () => {
    assert.equal(stageLabel({ jobType: 'validate', status: 'running' }, 'DST'), 'Validating');
    assert.equal(stageLabel({ jobType: 'export', status: 'running' }, 'DST'), 'Writing DST');
    assert.equal(
      stageLabel({ jobType: 'export', status: 'queued', parentJobId: 'p' }, 'PES'),
      'Digitizing',
    );
    assert.equal(stageLabel(null, 'DST'), '');
  });
});
