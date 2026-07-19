import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

import { settleGatherTask } from '../api/research.js';
import { fetchWithTimeout } from '../lib/fetch-timeout.js';

const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const fakeTimers = () => {
  let nextId = 1;
  const active = new Map();
  const cleared = [];
  return {
    active,
    cleared,
    setTimer(callback, delay) {
      const handle = { id: nextId++, delay };
      active.set(handle, callback);
      return handle;
    },
    clearTimer(handle) {
      cleared.push(handle);
      active.delete(handle);
    },
    fire(handle = active.keys().next().value) {
      const callback = active.get(handle);
      assert.ok(callback, 'timer handle must still be active');
      callback();
    }
  };
};

const runWithFakes = (task, timers, events) => settleGatherTask(task, {
  label: 'fixture',
  deadlineMs: 60_000,
  setTimer: timers.setTimer,
  clearTimer: timers.clearTimer,
  onFailure: (error) => events.push(`failure:${error.message}`),
  onTimeout: () => events.push('timeout')
});

test('successful gather tasks clear deadline handles without late warnings', async () => {
  const timers = fakeTimers();
  const events = [];
  const result = await runWithFakes(Promise.resolve({ ok: true }), timers, events);
  assert.deepEqual(result, { ok: true });
  assert.equal(timers.active.size, 0);
  assert.equal(timers.cleared.length, 1);
  assert.deepEqual(events, []);
});

test('failed and cancelled gather tasks clear deadline handles exactly once', async () => {
  for (const error of [
    new Error('provider failed'),
    Object.assign(new Error('caller cancelled'), { name: 'AbortError' })
  ]) {
    const timers = fakeTimers();
    const events = [];
    const result = await runWithFakes(Promise.reject(error), timers, events);
    assert.equal(result, null);
    assert.equal(timers.active.size, 0);
    assert.equal(timers.cleared.length, 1);
    assert.deepEqual(events, [`failure:${error.message}`]);
  }
});

test('timed-out gather tasks clear handles and ignore late settlement', async () => {
  const timers = fakeTimers();
  const events = [];
  const task = deferred();
  const pending = runWithFakes(task.promise, timers, events);
  const handle = timers.active.keys().next().value;
  timers.fire(handle);
  assert.equal(await pending, null);
  assert.equal(timers.active.size, 0);
  assert.equal(timers.cleared.length, 1);
  assert.deepEqual(events, ['timeout']);

  task.reject(new Error('late provider failure'));
  await Promise.resolve();
  assert.deepEqual(events, ['timeout']);
  assert.equal(timers.cleared.length, 1);
});

test('gather deadline aborts the underlying task signal', async () => {
  const timers = fakeTimers();
  const events = [];
  let observedSignal;
  const pending = runWithFakes((signal) => {
    observedSignal = signal;
    return new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
  }, timers, events);
  timers.fire();
  assert.equal(await pending, null);
  assert.equal(observedSignal.aborted, true);
  assert.equal(observedSignal.reason.code, 'ETIMEDOUT');
  assert.deepEqual(events, ['timeout']);
});

test('successful gather cleanup leaves no deadline handle delaying process exit', () => {
  const source = `
    const { settleGatherTask } = await import('./api/research.js');
    const result = await settleGatherTask(Promise.resolve('done'), { deadlineMs: 60_000 });
    process.stdout.write(result);
  `;
  const output = execFileSync(process.execPath, ['--input-type=module', '--eval', source], {
    cwd: new URL('..', import.meta.url),
    encoding: 'utf8',
    timeout: 2_000
  });
  assert.equal(output, 'done');
});

test('provider timeout wrapper removes upstream abort listeners on every exit', async () => {
  const cases = [
    {
      name: 'success',
      fetchImpl: async () => new Response('{}'),
      finish() {}
    },
    {
      name: 'failure',
      fetchImpl: async () => { throw new Error('offline failure'); },
      async finish(pending) { await assert.rejects(pending, /offline failure/); }
    },
    {
      name: 'cancelled',
      fetchImpl: async (_input, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
      finish(pending, controller) {
        controller.abort(new Error('cancelled'));
        return assert.rejects(pending, /cancelled/);
      }
    },
    {
      name: 'timed-out',
      timeoutMs: 5,
      fetchImpl: async (_input, { signal }) => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }),
      async finish(pending) {
        await assert.rejects(pending, (error) => error?.code === 'ETIMEDOUT');
      }
    }
  ];

  for (const fixture of cases) {
    const controller = new AbortController();
    const signal = controller.signal;
    const originalAdd = signal.addEventListener.bind(signal);
    const originalRemove = signal.removeEventListener.bind(signal);
    let added = 0;
    let removed = 0;
    signal.addEventListener = (...args) => {
      added += 1;
      return originalAdd(...args);
    };
    signal.removeEventListener = (...args) => {
      removed += 1;
      return originalRemove(...args);
    };

    const pending = fetchWithTimeout(
      'https://provider.offline.invalid',
      { signal },
      {
        timeoutMs: fixture.timeoutMs || 1_000,
        provider: fixture.name,
        fetchImpl: fixture.fetchImpl
      }
    );
    await fixture.finish(pending, controller);
    if (fixture.name === 'success') await pending;
    assert.equal(added, 1, fixture.name);
    assert.equal(removed, 1, fixture.name);
  }
});
