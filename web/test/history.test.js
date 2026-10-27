import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createHistory, HISTORY_LIMIT, record, redo, undo } from '../lib/history.js';

describe('undo/redo history', () => {
  it('undoes and redoes in order', () => {
    let h = createHistory('a');
    h = record(h, 'b');
    h = record(h, 'c');
    h = undo(h);
    assert.equal(h.present, 'b');
    h = undo(h);
    assert.equal(h.present, 'a');
    assert.equal(undo(h), h, 'nothing more to undo');
    h = redo(redo(h));
    assert.equal(h.present, 'c');
    assert.equal(redo(h), h, 'nothing more to redo');
  });

  it('drops the redo branch on a new edit', () => {
    let h = record(record(createHistory(1), 2), 3);
    h = record(undo(h), 4);
    assert.deepEqual(h.future, []);
    assert.equal(redo(h).present, 4);
  });

  it('keeps at least 200 steps and drops the oldest beyond the limit', () => {
    let h = createHistory(0);
    for (let i = 1; i <= HISTORY_LIMIT + 50; i++) h = record(h, i);
    assert.ok(HISTORY_LIMIT >= 200);
    assert.equal(h.past.length, HISTORY_LIMIT);
    for (let i = 0; i < HISTORY_LIMIT; i++) h = undo(h);
    assert.equal(h.present, 50);
  });

  it('ignores a no-op edit', () => {
    const h = createHistory('same');
    assert.equal(record(h, 'same'), h);
  });
});
