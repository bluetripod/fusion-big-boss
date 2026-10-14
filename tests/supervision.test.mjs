import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSupervisor } from '../shared/supervision.mjs';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function clock() {
  let time = 0;
  let unrefs = 0;
  const timers = new Map();
  return {
    now: () => time,
    schedule(callback, delay) {
      const timer = { unref() { unrefs++; } };
      timers.set(timer, { callback, delay, next: time + delay });
      return timer;
    },
    unschedule: timer => timers.delete(timer),
    async advance(amount) {
      const end = time + amount;
      while (true) {
        const next = [...timers.values()].sort((a, b) => a.next - b.next)[0];
        if (!next || next.next > end) break;
        time = next.next;
        next.next += next.delay;
        await next.callback();
      }
      time = end;
    },
    get size() { return timers.size; },
    get unrefs() { return unrefs; },
    callbacks: () => [...timers.values()].map(timer => timer.callback),
  };
}

function worker(id = 'worker-1', owner = 'owner-1', extra = {}) {
  return { id, owner, startedAt: 0, status: 'running', version: 1, requestable: true, ...extra };
}

function setup(options = {}) {
  const scheduler = clock();
  const updates = [];
  const requests = [];
  const supervisor = createSupervisor({
    ...scheduler,
    sample: async () => [worker()],
    notify: async (owner, text) => { updates.push({ owner, text }); },
    request: async (observation, text) => { requests.push({ observation, text }); return true; },
    ...options,
  });
  supervisor.start();
  return { supervisor, scheduler, updates, requests };
}

test('starts one unrefed 60-second timer without an immediate tick', async () => {
  const { supervisor, scheduler, updates } = setup();
  supervisor.start();
  assert.equal(scheduler.size, 1);
  assert.equal(scheduler.unrefs, 1);
  await scheduler.advance(59999);
  assert.deepEqual(updates, []);
  await scheduler.advance(1);
  assert.equal(updates.length, 1);
  assert.match(updates[0].text, /worker-1.*60s.*running/);
  supervisor.stop();
  await scheduler.advance(120000);
  assert.equal(updates.length, 1);
});

test('skips overlapping ticks while sampling and notifying', async () => {
  const sampling = deferred();
  const delivery = deferred();
  let samples = 0;
  let deliveries = 0;
  const { supervisor } = setup({
    sample: () => { samples++; return sampling.promise; },
    notify: () => { deliveries++; return delivery.promise; },
  });
  const pending = supervisor.tick();
  await supervisor.tick();
  assert.equal(samples, 1);
  sampling.resolve([worker()]);
  await Promise.resolve();
  await supervisor.tick();
  assert.equal(deliveries, 1);
  assert.equal(samples, 1);
  delivery.resolve();
  await pending;
});

test('groups exact owners independently, including identical worker IDs', async () => {
  const records = [worker('same', 'owner'), worker('same', 'owner '), worker('second', 'owner')];
  const { supervisor, updates, requests } = setup({ sample: async () => records });
  await supervisor.tick();
  assert.equal(updates.length, 2);
  assert.match(updates.find(update => update.owner === 'owner').text, /second/);
  assert.doesNotMatch(updates.find(update => update.owner === 'owner ').text, /second/);
  assert.equal(requests.length, 0);
  await supervisor.tick();
  assert.equal(requests.length, 3);
  assert.deepEqual(new Set(requests.map(entry => entry.observation.owner)), new Set(['owner', 'owner ']));
});

test('requests quiet progress once per observed version and resets on progress', async () => {
  let observation = Object.freeze(worker('full-worker-identity', 'owner', { activity: 'building' }));
  const { supervisor, requests, updates } = setup({ sample: async () => [observation] });
  await supervisor.tick();
  assert.equal(requests.length, 0);
  await supervisor.tick();
  await supervisor.tick();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].observation, observation);
  assert.match(updates.at(-1).text, /no observed progress/);
  observation = Object.freeze({ ...observation, version: 2, activity: 'testing' });
  await supervisor.tick();
  assert.equal(requests.length, 1);
  assert.doesNotMatch(updates.at(-1).text, /no observed progress/);
  await supervisor.tick();
  assert.equal(requests.length, 2);
});

test('unknown versions, non-running states and unsupported workers never request progress', async () => {
  const observations = [
    worker('unknown', 'owner', { version: undefined }),
    worker('queued', 'owner', { status: 'queued' }),
    worker('unsupported', 'owner', { requestable: false }),
    worker('unrecognized', 'owner', { status: 'mystery-state' }),
  ];
  const { supervisor, requests, updates } = setup({ sample: async () => observations });
  await supervisor.tick();
  assert.match(updates[0].text, /progress unknown/);
  await supervisor.tick();
  await supervisor.tick();
  assert.equal(requests.length, 0);
});

test('retains the sampled version when adapters reuse mutable observation objects', async () => {
  const observation = worker();
  const { supervisor, requests, updates } = setup({ sample: async () => [observation] });
  await supervisor.tick();
  observation.version++;
  await supervisor.tick();
  assert.equal(requests.length, 0);
  assert.doesNotMatch(updates.at(-1).text, /no observed progress/);
  await supervisor.tick();
  assert.equal(requests.length, 1);
  observation.version = undefined;
  await supervisor.tick();
  observation.version = 3;
  await supervisor.tick();
  assert.equal(requests.length, 1);
});

test('failed and unsupported requests stay outstanding; other owners still receive updates', async () => {
  const attempted = [];
  const delivered = [];
  const { supervisor } = setup({
    sample: async () => [worker('bad', 'bad-owner'), worker('unsupported', 'other-owner')],
    request: async observation => {
      attempted.push(observation.id);
      if (observation.id === 'bad') throw new Error('private request failure');
      return false;
    },
    notify: async (owner, text) => {
      if (owner === 'bad-owner') throw new Error('private notify failure');
      delivered.push(text);
    },
  });
  await supervisor.tick();
  await supervisor.tick();
  await supervisor.tick();
  assert.deepEqual(attempted, ['bad', 'unsupported']);
  assert.equal(delivered.length, 3);
  assert.match(delivered.at(-1), /request unavailable/);
  assert.doesNotMatch(delivered.at(-1), /private/);
});

test('sample failure preserves records and reports status unavailable without false completion', async () => {
  let fail = false;
  const { supervisor, scheduler, updates, requests } = setup({ sample: async () => {
    if (fail) throw new Error('raw private logs');
    return [worker()];
  } });
  await supervisor.tick();
  fail = true;
  await supervisor.tick();
  assert.equal(scheduler.size, 1);
  assert.match(updates.at(-1).text, /worker status unavailable/);
  assert.doesNotMatch(updates.at(-1).text, /raw private logs|completed/);
  fail = false;
  await supervisor.tick();
  assert.equal(requests.length, 1);
});

test('preserves full status details for every worker while sanitizing control characters', async () => {
  const hostile = '\u001b[31m\n\r\t\u202e';
  let records = [worker('quiet-stable-full-id', 'owner')];
  const { supervisor, updates } = setup({ sample: async () => records });
  await supervisor.tick();
  records = [
    ...Array.from({ length: 4 }, (_, index) => worker(`worker-${index}-${hostile}long-session-identity-that-must-remain-usable`, 'owner', {
      activity: `${hostile}Waiting for the deployment check to finish; blocked by a required account permission for worker ${index}.`,
      status: 'waiting for external command completion',
    })),
    ...records,
  ];
  await supervisor.tick();
  const text = updates.at(-1).text;
  assert.match(text.split('\n')[0], /quiet-stable-full-id.*no observed progress/);
  for (let index = 0; index < 4; index++) {
    assert.ok(text.includes(`worker-${index}-long-session-identity-that-must-remain-usable`));
    assert.ok(text.includes(`Waiting for the deployment check to finish; blocked by a required account permission for worker ${index}.`));
  }
  assert.ok(text.includes('waiting for external command completion'));
  assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u202e]/);
});

test('omitted workers lose their baseline and empty samples stop monitoring', async () => {
  let records = [worker('first'), worker('remaining')];
  const { supervisor, scheduler, updates, requests } = setup({ sample: async () => records });
  await supervisor.tick();
  records = [worker('remaining')];
  await supervisor.tick();
  assert.doesNotMatch(updates.at(-1).text, /first/);
  records = [worker('first')];
  await supervisor.tick();
  assert.equal(requests.length, 1);
  records = [];
  await supervisor.tick();
  assert.equal(scheduler.size, 0);
  const count = updates.length;
  await supervisor.tick();
  await scheduler.advance(120000);
  assert.equal(updates.length, count);
});

test('stop invalidates awaited samples and old scheduled callbacks across restart', async () => {
  const sampling = deferred();
  let sample = () => sampling.promise;
  const { supervisor, scheduler, updates, requests } = setup({ sample: () => sample() });
  const oldCallback = scheduler.callbacks()[0];
  const pending = supervisor.tick();
  supervisor.stop();
  sample = async () => [worker('new-worker')];
  supervisor.start();
  await oldCallback();
  assert.deepEqual(updates, []);
  sampling.resolve([worker('stale-worker')]);
  await pending;
  assert.deepEqual(updates, []);
  assert.deepEqual(requests, []);
  await supervisor.tick();
  assert.match(updates[0].text, /new-worker/);
  assert.equal(requests.length, 0);
});

test('stop during a request prevents stale notifications and further requests', async () => {
  const sending = deferred();
  const attempted = [];
  const { supervisor, updates } = setup({
    sample: async () => [worker('first'), worker('second', 'other-owner')],
    request: observation => { attempted.push(observation.id); return sending.promise; },
  });
  await supervisor.tick();
  updates.length = 0;
  const pending = supervisor.tick();
  await Promise.resolve();
  supervisor.stop();
  sending.resolve(true);
  await pending;
  assert.deepEqual(attempted, ['first']);
  assert.deepEqual(updates, []);
});

test('stop during delivery prevents notifications to later owners', async () => {
  const delivering = deferred();
  const delivered = [];
  const { supervisor } = setup({
    sample: async () => [worker('first', 'first-owner'), worker('second', 'second-owner')],
    notify: owner => { delivered.push(owner); return delivering.promise; },
  });
  const pending = supervisor.tick();
  await Promise.resolve();
  supervisor.stop();
  delivering.resolve();
  await pending;
  assert.deepEqual(delivered, ['first-owner']);
});
