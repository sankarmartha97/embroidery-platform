// S2-13 done-when: allow + deny unit tests for every rule (04-api/authorization.md).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canCreateExport,
  canCreateJob,
  canCreateProject,
  canDownloadArtifact,
  canEditDraft,
  downloadDecision,
  canManageCollaborators,
  canManageRights,
  canReadProject,
  canReview,
  canSubmit,
} from '../../src/modules/projects/index.js';

const actor = (userId, ...roles) => ({ userId, roles: new Set(['customer', ...roles]) });
const OWNER = actor('owner', 'designer');
const STRANGER = actor('stranger', 'designer');
const project = { id: 'p1', ownerUserId: 'owner', status: 'draft' };
const editor = (extra = {}) => ({
  userId: 'collab',
  role: 'editor',
  canExport: false,
  revokedAt: null,
  ...extra,
});
const viewer = { userId: 'collab', role: 'viewer', canExport: false, revokedAt: null };
const COLLAB = actor('collab', 'designer');

describe('canReadProject', () => {
  it('allows owner, active collaborator and staff', () => {
    assert.equal(canReadProject(OWNER, project, null), true);
    assert.equal(canReadProject(COLLAB, project, viewer), true);
    assert.equal(canReadProject(actor('mod', 'staff.moderator'), project, null), true);
  });
  it('denies strangers, revoked collaborators and anonymous callers', () => {
    assert.equal(canReadProject(STRANGER, project, null), false);
    assert.equal(canReadProject(COLLAB, project, { ...viewer, revokedAt: new Date() }), false);
    assert.equal(
      canReadProject(STRANGER, project, viewer),
      false,
      'collaborator row of someone else',
    );
    assert.equal(canReadProject(null, project, null), false);
  });
});

describe('canEditDraft', () => {
  it('allows owner, editor collaborator and staff.designer', () => {
    assert.equal(canEditDraft(OWNER, project, null), true);
    assert.equal(canEditDraft(COLLAB, project, editor()), true);
    assert.equal(canEditDraft(actor('s', 'staff.designer'), project, null), true);
  });
  it('denies viewers and other staff roles', () => {
    assert.equal(canEditDraft(COLLAB, project, viewer), false);
    assert.equal(canEditDraft(actor('m', 'staff.moderator'), project, null), false);
  });
});

describe('canCreateJob', () => {
  it('allows editors with the digitize permission', () => {
    assert.equal(canCreateJob(OWNER, project, null), true);
    assert.equal(canCreateJob(COLLAB, project, editor()), true);
  });
  it('denies editors without the digitize permission', () => {
    assert.equal(canCreateJob(actor('owner'), project, null), false);
    assert.equal(canCreateJob(actor('collab'), project, editor()), false);
  });
});

describe('canCreateExport', () => {
  it('allows the owner and collaborators with can_export', () => {
    assert.equal(canCreateExport(OWNER, project, null), true);
    assert.equal(canCreateExport(COLLAB, project, editor({ canExport: true })), true);
  });
  it('denies editors without can_export', () => {
    assert.equal(canCreateExport(COLLAB, project, editor()), false);
  });
});

describe('canDownloadArtifact / downloadDecision', () => {
  const onSale = { ...project, status: 'published', publishedVersionId: 'v1' };
  const machineFile = { artifactType: 'machine_file', projectVersionId: 'v1' };
  const preview = { artifactType: 'preview', projectVersionId: 'v1' };
  const buyer = actor('buyer');
  const purchase = { current: true, basis: 'purchase', ref: 'order-1' };

  it('allows the owner, staff and collaborators, with the basis recorded', () => {
    assert.deepEqual(downloadDecision(OWNER, project, null, machineFile, null), {
      allowed: true,
      basis: 'owner',
    });
    assert.equal(
      downloadDecision(actor('m', 'staff.moderator'), project, null, machineFile, null).basis,
      'staff',
    );
    assert.deepEqual(downloadDecision(COLLAB, project, viewer, preview, null), {
      allowed: true,
      basis: 'collaborator',
    });
    assert.equal(
      canDownloadArtifact(COLLAB, project, editor({ canExport: true }), machineFile, null),
      true,
    );
  });

  it('needs the export permission for collaborators to download machine files', () => {
    assert.deepEqual(downloadDecision(COLLAB, project, viewer, machineFile, null), {
      allowed: false,
      basis: 'collaborator',
      reason: 'EXPORT_NOT_ALLOWED',
    });
    assert.equal(canDownloadArtifact(COLLAB, project, editor(), machineFile, null), false);
  });

  it('allows entitled customers machine files and previews of the published version', () => {
    assert.deepEqual(downloadDecision(buyer, onSale, null, machineFile, purchase), {
      allowed: true,
      basis: 'purchase',
    });
    assert.equal(
      downloadDecision(buyer, onSale, null, preview, { current: true, basis: 'subscription' })
        .basis,
      'subscription',
    );
  });

  it('asks customers without an entitlement to buy (ENTITLEMENT_REQUIRED)', () => {
    for (const entitlement of [null, { current: false, basis: 'purchase' }]) {
      assert.deepEqual(downloadDecision(buyer, onSale, null, machineFile, entitlement), {
        allowed: false,
        basis: 'none',
        reason: 'ENTITLEMENT_REQUIRED',
      });
    }
  });

  it('hides everything else from customers (NOT_VISIBLE)', () => {
    const cases = [
      [project, machineFile], // not published
      [onSale, { artifactType: 'stitch_data', projectVersionId: 'v1' }], // not a customer type
      [onSale, { artifactType: 'machine_file', projectVersionId: 'v2' }], // a later version
      [{ ...onSale, publishedVersionId: null }, machineFile], // no approved publication
    ];
    for (const [p, a] of cases) {
      assert.equal(downloadDecision(buyer, p, null, a, purchase).reason, 'NOT_VISIBLE');
    }
    assert.equal(canDownloadArtifact(null, onSale, null, machineFile, purchase), false);
  });

  it('treats a revoked collaborator as a stranger', () => {
    const revoked = { ...viewer, revokedAt: new Date() };
    assert.equal(downloadDecision(COLLAB, project, revoked, preview, null).reason, 'NOT_VISIBLE');
  });
});

describe('canCreateProject / canManageCollaborators', () => {
  it('allows designers and staff.designer to create, and only the owner to share', () => {
    assert.equal(canCreateProject(OWNER), true);
    assert.equal(canCreateProject(actor('s', 'staff.designer')), true);
    assert.equal(canManageCollaborators(OWNER, project), true);
  });
  it('denies customers, other staff and non-owners', () => {
    assert.equal(canCreateProject(actor('buyer')), false);
    assert.equal(canCreateProject(actor('m', 'staff.moderator')), false);
    assert.equal(canCreateProject(null), false);
    assert.equal(canManageCollaborators(COLLAB, project), false);
    assert.equal(canManageCollaborators(actor('a', 'staff.admin'), project), false);
  });
});

describe('canSubmit / canReview / canManageRights', () => {
  it('allows the right roles', () => {
    assert.equal(canSubmit(OWNER, project), true);
    assert.equal(canReview(actor('m', 'staff.moderator')), true);
    assert.equal(canManageRights(actor('r', 'staff.rights_admin')), true);
  });
  it('denies everyone else', () => {
    assert.equal(canSubmit(COLLAB, project), false);
    assert.equal(canReview(actor('a', 'staff.admin')), false);
    assert.equal(canReview(OWNER), false);
    assert.equal(canManageRights(actor('m', 'staff.moderator')), false);
  });
});
