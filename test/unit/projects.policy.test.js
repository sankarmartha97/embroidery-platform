// S2-13 done-when: allow + deny unit tests for every rule (04-api/authorization.md).
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canCreateExport,
  canCreateJob,
  canDownloadArtifact,
  canEditDraft,
  canManageRights,
  canReadProject,
  canReview,
  canSubmit,
} from '../../src/modules/projects/index.js';

const actor = (userId, ...roles) => ({ userId, roles: new Set(['customer', ...roles]) });
const OWNER = actor('owner', 'designer');
const STRANGER = actor('stranger', 'designer');
const project = { id: 'p1', ownerUserId: 'owner', status: 'draft' };
const published = { ...project, status: 'published' };
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

describe('canDownloadArtifact', () => {
  const machineFile = { artifactType: 'machine_file' };
  it('allows readers and entitled customers of published designs', () => {
    assert.equal(canDownloadArtifact(OWNER, project, null, machineFile, null), true);
    assert.equal(
      canDownloadArtifact(actor('buyer'), published, null, machineFile, { current: true }),
      true,
    );
    assert.equal(
      canDownloadArtifact(
        actor('buyer'),
        published,
        null,
        { artifactType: 'preview' },
        { current: true },
      ),
      true,
    );
  });
  it('denies customers without entitlement, unpublished designs and source artifacts', () => {
    const buyer = actor('buyer');
    assert.equal(
      canDownloadArtifact(buyer, published, null, machineFile, { current: false }),
      false,
    );
    assert.equal(canDownloadArtifact(buyer, published, null, machineFile, null), false);
    assert.equal(canDownloadArtifact(buyer, project, null, machineFile, { current: true }), false);
    assert.equal(
      canDownloadArtifact(
        buyer,
        published,
        null,
        { artifactType: 'stitch_data' },
        { current: true },
      ),
      false,
    );
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
