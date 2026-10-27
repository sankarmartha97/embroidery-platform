import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createAutosave, STATUS } from '../lib/autosave.js';

/** Manual clock: timers fire only when advance() passes their due time. */
function fakeTimers() {
  let now = 0;
  let seq = 0;
  const pending = new Map();
  return {
    setTimeout(fn, ms) {
      const id = ++seq;
      pending.set(id, { due: now + ms, fn });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...pending.entries()].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next || next[1].due > until) break;
        pending.delete(next[0]);
        now = next[1].due;
        next[1].fn(); // like a real timer: fire, don't wait for the callback
        await new Promise((resolve) => setImmediate(resolve)); // let settled saves run
      }
      now = until;
    },
  };
}

function setup(saveImpl) {
  const timers = fakeTimers();
  const saves = [];
  const statuses = [];
  const autosave = createAutosave({
    revision: 0,
    timers,
    onChange: (s) => statuses.push(s.status),
    save: async (doc, revision) => {
      saves.push({ doc, revision });
      return saveImpl ? saveImpl(doc, revision) : { draftRevision: revision + 1 };
    },
  });
  return { autosave, timers, saves, statuses };
}

describe('autosave', () => {
  it('saves 2 s after the last edit, with the current revision', async () => {
    const { autosave, timers, saves } = setup();
    autosave.edit('v1');
    await timers.advance(1500);
    autosave.edit('v2'); // restarts the debounce
    await timers.advance(1500);
    assert.equal(saves.length, 0);
    await timers.advance(600);
    assert.deepEqual(saves, [{ doc: 'v2', revision: 0 }]);
    assert.equal(autosave.getState().status, STATUS.SAVED);
    assert.equal(autosave.getState().revision, 1);
  });

  it('saves at least every 30 s while edits keep coming', async () => {
    const { autosave, timers, saves } = setup();
    for (let t = 0; t < 31_000; t += 1000) {
      autosave.edit(`v${t}`);
      await timers.advance(1000);
    }
    assert.equal(saves.length, 1, 'the max-wait timer fired despite constant edits');
  });

  it('saves again when edits arrive during a save', async () => {
    let release;
    const { autosave, timers, saves } = setup(
      (doc, revision) =>
        new Promise((resolve) => {
          release = () => resolve({ draftRevision: revision + 1 });
        }),
    );
    autosave.edit('a');
    await timers.advance(2000);
    assert.equal(autosave.getState().status, STATUS.SAVING);
    autosave.edit('b');
    release();
    await new Promise((r) => setImmediate(r));
    assert.equal(autosave.getState().status, STATUS.DIRTY);
    await timers.advance(2000);
    release();
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(
      saves.map((s) => [s.doc, s.revision]),
      [
        ['a', 0],
        ['b', 1],
      ],
    );
    assert.equal(autosave.getState().status, STATUS.SAVED);
  });

  it('stops on a conflict until the user decides', async () => {
    const { autosave, timers, saves } = setup(() => {
      throw Object.assign(new Error('conflict'), { status: 409, code: 'DRAFT_CONFLICT' });
    });
    autosave.edit('mine');
    await timers.advance(2000);
    assert.equal(autosave.getState().status, STATUS.CONFLICT);
    autosave.edit('more');
    await timers.advance(60_000);
    assert.equal(saves.length, 1, 'no saves while in conflict');
    assert.ok(autosave.hasUnsavedChanges());
  });

  it('"save mine" continues from the server revision; "reload theirs" discards', async () => {
    let fail = true;
    const { autosave, timers, saves } = setup((doc, revision) => {
      if (fail) throw Object.assign(new Error('conflict'), { status: 409, code: 'DRAFT_CONFLICT' });
      return { draftRevision: revision + 1 };
    });
    autosave.edit('mine');
    await timers.advance(2000);
    fail = false;
    await autosave.overrideRevision(7);
    assert.deepEqual(saves.at(-1), { doc: 'mine', revision: 7 });
    assert.equal(autosave.getState().revision, 8);

    autosave.reset(12);
    assert.equal(autosave.getState().status, STATUS.SAVED);
    assert.equal(autosave.hasUnsavedChanges(), false);
  });

  it('goes offline on network errors and retries until it succeeds', async () => {
    let attempts = 0;
    const { autosave, timers } = setup((doc, revision) => {
      attempts += 1;
      if (attempts < 3) throw new TypeError('Failed to fetch');
      return { draftRevision: revision + 1 };
    });
    autosave.edit('x');
    await timers.advance(2000);
    assert.equal(autosave.getState().status, STATUS.OFFLINE);
    await timers.advance(5000);
    assert.equal(autosave.getState().status, STATUS.OFFLINE);
    await timers.advance(5000);
    assert.equal(autosave.getState().status, STATUS.SAVED);
    assert.equal(attempts, 3);
  });

  it('shows invalid documents without retrying, and tries again after the next edit', async () => {
    let attempts = 0;
    const { autosave, timers } = setup((doc, revision) => {
      attempts += 1;
      if (doc === 'bad') throw Object.assign(new Error('invalid'), { status: 422 });
      return { draftRevision: revision + 1 };
    });
    autosave.edit('bad');
    await timers.advance(2000);
    assert.equal(autosave.getState().status, STATUS.INVALID);
    await timers.advance(60_000);
    assert.equal(attempts, 1);
    autosave.edit('good');
    await timers.advance(2000);
    assert.equal(autosave.getState().status, STATUS.SAVED);
  });
});
