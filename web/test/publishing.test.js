import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RIGHTS_TYPES, submitChecklist } from '../lib/publishing.js';

const designRights = (status = 'declared') => ({ assetId: null, verificationStatus: status });
const exported = (validationStatus) => [
  { artifactType: 'machine_file' },
  { artifactType: 'stitch_data', validationStatus },
];
const ok = (state) => Object.fromEntries(submitChecklist(state).items.map((i) => [i.id, i.ok]));

describe('submit checklist', () => {
  it('is ready with design rights, a validated export and the terms', () => {
    const state = { rights: [designRights()], artifacts: exported('warning'), terms: true };
    assert.equal(submitChecklist(state).ready, true);
  });

  it('ignores rejected and asset-only declarations', () => {
    assert.equal(
      ok({ rights: [designRights('rejected')], artifacts: [], terms: true }).rights,
      false,
    );
    assert.equal(
      ok({ rights: [{ assetId: 'a', verificationStatus: 'verified' }], artifacts: [], terms: true })
        .rights,
      false,
    );
  });

  it('needs an export and stitch data that passed, not failed or pending', () => {
    assert.deepEqual(ok({ rights: [], artifacts: null, terms: false }), {
      rights: false,
      export: false,
      validated: false,
      terms: false,
    });
    assert.equal(ok({ rights: [], artifacts: exported('failed'), terms: false }).validated, false);
    assert.equal(ok({ rights: [], artifacts: exported('pending'), terms: false }).validated, false);
    const noFile = [{ artifactType: 'stitch_data', validationStatus: 'passed' }];
    assert.deepEqual(
      [
        ok({ rights: [], artifacts: noFile, terms: false }).export,
        ok({ rights: [], artifacts: noFile, terms: false }).validated,
      ],
      [false, true],
    );
  });

  it('asks for a holder and a source where the server does', () => {
    const rule = Object.fromEntries(
      RIGHTS_TYPES.map((t) => [t.id, [Boolean(t.needsHolder), Boolean(t.needsSource)]]),
    );
    assert.deepEqual(rule, {
      owned: [false, false],
      licensed: [true, true],
      commissioned: [true, true],
      public_domain: [false, true],
    });
  });
});
