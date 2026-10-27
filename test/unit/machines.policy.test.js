import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  canManageOwnMachines,
  canViewMachine,
} from '../../src/modules/machines/machines.policy.js';

describe('machines policy', () => {
  const me = { userId: 'u1', roles: new Set(['customer']) };
  it('allows an authenticated user to manage and view their own machines', () => {
    assert.equal(canManageOwnMachines(me), true);
    assert.equal(canViewMachine(me, { userId: 'u1' }), true);
  });
  it("denies anonymous callers and other users' machines", () => {
    assert.equal(canManageOwnMachines(null), false);
    assert.equal(canViewMachine(me, { userId: 'u2' }), false);
  });
});
