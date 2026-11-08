import { test } from 'node:test';
import assert from 'node:assert/strict';
import { backoffMs, createAutopilot, nextLocalMidnight, rateCheck, type RateInput } from '../server/autopilot.ts';
import { openDb } from '../server/db.ts';
import { createBus, createEngine } from '../server/engine.ts';
import { DEFAULT_APP_SETTINGS, type ChatRequest } from '../server/providers.ts';

const T = Date.parse('2026-11-02T12:00:00');
const base: RateInput = {
  now: T, steps: [], lastAt: 0, paceSeconds: 10, stepsPerHour: 60, boardSpent: 0, boardUsdPerDay: 1,
  globalSpent: 0, globalUsdPerDay: 5, errors: 0, lastErrorAt: 0,
};

test('rate limiter: budgets, backoff, hourly window, pace', () => {
  assert.deepEqual(rateCheck(base), { ok: true });
  assert.deepEqual(rateCheck({ ...base, globalSpent: 5 }), { ok: false, reason: 'global_budget', until: nextLocalMidnight(T) });
  assert.equal((rateCheck({ ...base, boardSpent: 1.2 }) as any).reason, 'board_budget');
  assert.equal((rateCheck({ ...base, boardSpent: 0.99 }) as any).ok, true);
  // 0 = free models only: nothing spent keeps running, the first paid cent stops it
  assert.equal(rateCheck({ ...base, boardUsdPerDay: 0, boardSpent: 0 }).ok, true);
  assert.equal((rateCheck({ ...base, boardUsdPerDay: 0, boardSpent: 0.001 }) as any).reason, 'board_budget');

  assert.deepEqual([1, 2, 3, 10].map(backoffMs), [30_000, 60_000, 120_000, 900_000]);
  assert.equal((rateCheck({ ...base, errors: 2, lastErrorAt: T - 30_000 }) as any).reason, 'backoff');
  assert.equal(rateCheck({ ...base, errors: 2, lastErrorAt: T - 61_000 }).ok, true);

  const steps = [T - 3_500_000, T - 1000];
  assert.deepEqual(rateCheck({ ...base, steps, stepsPerHour: 2 }), { ok: false, reason: 'hourly', until: T - 3_500_000 + 3_600_000 });
  assert.equal(rateCheck({ ...base, steps: [T - 3_700_000, T - 1000], stepsPerHour: 2 }).ok, true, 'old steps leave the window');

  assert.deepEqual(rateCheck({ ...base, lastAt: T - 4000 }), { ok: false, reason: 'pace', until: T + 6000 });
});

test('local midnight is the next calendar day at 00:00', () => {
  const m = new Date(nextLocalMidnight(T));
  assert.deepEqual([m.getDate(), m.getHours(), m.getMinutes()], [3, 0, 0]);
});

function fakeEngineFor(repo: ReturnType<typeof openDb>) {
  const bus = createBus();
  const steps: number[] = [];
  let fail = false;
  return {
    steps,
    setFail: (v: boolean) => (fail = v),
    engine: {
      bus,
      async autoStep(boardId: number) {
        if (fail) throw Object.assign(new Error('no key'), { code: 'no_key' });
        steps.push(boardId);
        repo.addSpend(boardId, 0.3);
        return { did: 'combine' as const };
      },
    } as any,
  };
}

test('scheduler: only auto boards run, at their pace, within their limits', async () => {
  const repo = openDb(':memory:');
  let now = T;
  const { engine, steps, setFail } = fakeEngineFor(repo);
  const ap = createAutopilot({ repo, engine, settings: () => DEFAULT_APP_SETTINGS, now: () => now });
  const auto = repo.createBoard({ title: 'Auto', config: { mode: 'auto', autopilotSeconds: 10, rate: { stepsPerHour: 3, usdPerDay: 100 } } });
  repo.createBoard({ title: 'Manual' });
  const flush = () => new Promise((r) => setTimeout(r, 5));

  await ap.tick(); await flush();
  assert.deepEqual(steps, [auto.id], 'the manual board never runs');
  now += 5_000; await ap.tick(); await flush();
  assert.equal(steps.length, 1);
  assert.equal(ap.status(auto.id).state, 'pace');
  now += 5_000; await ap.tick(); await flush();
  now += 10_000; await ap.tick(); await flush();
  assert.equal(steps.length, 3);
  now += 10_000; await ap.tick(); await flush();
  assert.equal(steps.length, 3, 'three steps per hour');
  assert.equal(ap.status(auto.id).state, 'hourly');

  // Errors back off, and the status says why.
  now += 3_600_000; setFail(true);
  await ap.tick(); await flush();
  assert.equal(ap.status(auto.id).state, 'error');
  assert.equal(ap.status(auto.id).code, 'no_key');
  now += 15_000; await ap.tick(); await flush();
  assert.equal(ap.status(auto.id).state, 'backoff');
  setFail(false);
  now += 30_000; await ap.tick(); await flush();
  assert.equal(steps.length, 4, 'recovers after the backoff');

  // Budget: the board has spent 4 × $0.30; a $1 cap stops it until midnight.
  repo.updateBoard(auto.id, { config: { rate: { stepsPerHour: 3, usdPerDay: 1 } } });
  now += 20_000; await ap.tick(); await flush();
  assert.equal(ap.status(auto.id).state, 'board_budget');
  assert.equal(steps.length, 4);

  repo.updateBoard(auto.id, { config: { mode: 'manual' } });
  await ap.tick();
  assert.equal(ap.status(auto.id).state, 'manual');
});

test('scheduler: a deleted board is forgotten, also while its step is still running', async () => {
  const repo = openDb(':memory:');
  let now = T;
  const { engine, steps } = fakeEngineFor(repo);
  const ap = createAutopilot({ repo, engine, settings: () => DEFAULT_APP_SETTINGS, now: () => now });
  const config = { mode: 'auto', autopilotSeconds: 10, rate: { stepsPerHour: 60, usdPerDay: 100 } };
  const keep = repo.createBoard({ title: 'Keep', config });
  const gone = repo.createBoard({ title: 'Gone', config });
  const flush = () => new Promise((r) => setTimeout(r, 5));

  await ap.tick(); await flush();
  assert.deepEqual(ap.tracked().sort(), [keep.id, gone.id].sort());
  assert.equal(ap.status(gone.id).state, 'pace');

  repo.deleteBoard(gone.id);
  now += 20_000; await ap.tick(); await flush();
  assert.deepEqual(ap.tracked(), [keep.id], 'the deleted board has no state left');
  assert.equal(ap.status(gone.id).state, 'manual');
  assert.ok(!steps.slice(2).includes(gone.id), 'and no step ran for it');

  // Deleted between the start of a step and its result: the late result does not bring the entry back.
  let release!: () => void;
  const slow = { ...engine, autoStep: (id: number) => new Promise<{ did: 'combine' }>((r) => { release = () => r({ did: 'combine' }); steps.push(id); }) };
  const ap2 = createAutopilot({ repo, engine: slow, settings: () => DEFAULT_APP_SETTINGS, now: () => now });
  await ap2.tick();
  assert.equal(ap2.status(keep.id).state, 'running');
  repo.deleteBoard(keep.id);
  await ap2.tick();
  release(); await flush();
  await ap2.tick();
  assert.deepEqual(ap2.tracked(), []);
});

test('scheduler: a new board that reuses a deleted board\'s id starts clean, even while the old step still runs', async () => {
  for (const outcome of ['result', 'error'] as const) {
    const repo = openDb(':memory:');
    let now = T;
    const { engine } = fakeEngineFor(repo);
    const finish: Array<() => void> = [];
    const slow = {
      ...engine,
      autoStep: () => new Promise<{ did: 'combine' }>((ok, fail) => {
        finish.push(() => (outcome === 'result' ? ok({ did: 'combine' }) : fail(Object.assign(new Error('no key'), { code: 'no_key' }))));
      }),
    };
    const ap = createAutopilot({ repo, engine: slow, settings: () => DEFAULT_APP_SETTINGS, now: () => now });
    const config = { mode: 'auto', autopilotSeconds: 10, rate: { stepsPerHour: 1, usdPerDay: 100 } };
    const old = repo.createBoard({ title: 'Old', config });
    const flush = () => new Promise((r) => setTimeout(r, 5));

    await ap.tick();
    assert.equal(ap.status(old.id).state, 'running', `${outcome}: the old board's step is under way`);

    // Deleted mid-step, as the DELETE route does it; the next board gets the same id.
    ap.forget(old.id);
    repo.deleteBoard(old.id);
    const reused = repo.createBoard({ title: 'New', config });
    assert.equal(reused.id, old.id, 'SQLite hands out the freed id again');
    assert.equal(ap.status(reused.id).state, 'manual', `${outcome}: no status carried over`);

    const seen: any[] = [];
    engine.bus.on(reused.id, (e: any) => seen.push(e.status));
    finish[0](); await flush();
    assert.deepEqual(seen, [], `${outcome}: the old step publishes nothing on the new board`);
    assert.equal(ap.status(reused.id).state, 'manual');

    // The new board runs a step of its own at once: no hour of steps (limit 1), no
    // error backoff and no last result from the old board.
    await ap.tick();
    assert.equal(finish.length, 2, `${outcome}: the new board's own first step started`);
    assert.equal(ap.status(reused.id).state, 'running');
    assert.equal(ap.status(reused.id).last, undefined, `${outcome}: no last result from the old board`);
    assert.equal(ap.status(reused.id).stepsLastHour, 0, `${outcome}: the old step is not in the new board's hour`);
    finish[1](); await flush();
  }
});

test('scheduler: a board deleted without forget() is still dropped at the next tick, busy or not', async () => {
  const repo = openDb(':memory:');
  const { engine } = fakeEngineFor(repo);
  let release!: () => void;
  const slow = { ...engine, autoStep: () => new Promise<{ did: 'combine' }>((r) => { release = () => r({ did: 'combine' }); }) };
  const ap = createAutopilot({ repo, engine: slow, settings: () => DEFAULT_APP_SETTINGS, now: () => T });
  const board = repo.createBoard({ title: 'B', config: { mode: 'auto', autopilotSeconds: 10, rate: { stepsPerHour: 60, usdPerDay: 100 } } });
  await ap.tick();
  repo.deleteBoard(board.id);
  await ap.tick();
  assert.deepEqual(ap.tracked(), [], 'dropped while its step runs');
  const seen: any[] = [];
  engine.bus.on(board.id, (e: any) => seen.push(e));
  release(); await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(seen, [], 'and its late result goes nowhere');
  assert.deepEqual(ap.tracked(), []);
});

test('autoStep with the real engine: judge first, grow a small pool, then breed', async () => {
  const repo = openDb(':memory:');
  let n = 0;
  const chat = async (r: ChatRequest) => {
    n++;
    const value =
      r.schemaName === 'expand' ? { ideas: [1, 2, 3].map((k) => ({ title: `Idé ${n}.${k}`, pitch: 'p' })) }
      : r.schemaName === 'judgement' ? { reason: 'r', originality: 2 + (n % 3), feasibility: 3, impact: 3, keywords: ['k'] }
      : { title: `Korsning ${n}`, pitch: 'p' };
    return { value, costUsd: 0 };
  };
  const engine = createEngine({ repo, chat, settings: () => DEFAULT_APP_SETTINGS, gitInit: false });
  const board = repo.createBoard({ title: 'B' });
  assert.deepEqual(await engine.autoStep(board.id), { did: 'idle', reason: 'empty' });
  repo.insertIdea({ boardId: board.id, title: 'Frö', pitch: '', kind: 'seed', x: 0, y: 0, generation: 0 });

  const did: string[] = [];
  for (let i = 0; i < 6; i++) did.push((await engine.autoStep(board.id)).did);
  assert.equal(did[0], 'judge', 'an unjudged seed is judged first');
  assert.equal(did[1], 'expand', 'a pool under three grows by expanding');
  assert.ok(did.includes('combine'), `breeds once the pool is big enough: ${did.join(',')}`);
  const ideas = repo.listIdeas(board.id);
  assert.ok(ideas.every((i) => i.judgedAt), 'every step leaves its ideas judged');
  assert.ok(ideas.some((i) => i.kind === 'combine' && i.generation >= 2));
});

test('scheduler: switching a board to manual and back neither doubles a running step nor resets its limits', async () => {
  const repo = openDb(':memory:');
  let now = T;
  const { engine } = fakeEngineFor(repo);
  let started = 0;
  let running = 0;
  let release!: () => void;
  const slow = {
    ...engine,
    autoStep: () => {
      started++;
      running++;
      return new Promise<{ did: 'combine' }>((r) => { release = () => { running--; r({ did: 'combine' }); }; });
    },
  };
  const ap = createAutopilot({ repo, engine: slow, settings: () => DEFAULT_APP_SETTINGS, now: () => now });
  const board = repo.createBoard({ title: 'Toggle', config: { mode: 'auto', autopilotSeconds: 10, rate: { stepsPerHour: 1, usdPerDay: 100 } } });
  const mode = (id: number, m: 'auto' | 'manual') => repo.updateBoard(id, { config: { mode: m } });
  const flush = () => new Promise((r) => setTimeout(r, 5));

  await ap.tick();
  assert.equal(started, 1);
  mode(board.id, 'manual'); await ap.tick();
  mode(board.id, 'auto'); now += 1_000; await ap.tick();
  assert.equal(started, 1, 'no second step beside the one still running');
  assert.equal(running, 1);
  assert.equal(ap.status(board.id).state, 'running');
  release(); await flush();

  // That step used the hour's one step, and a round trip through manual does not hand it back.
  mode(board.id, 'manual'); await ap.tick();
  assert.equal(ap.status(board.id).state, 'manual');
  mode(board.id, 'auto'); now += 60_000; await ap.tick(); await flush();
  assert.equal(started, 1);
  assert.equal(ap.status(board.id).state, 'hourly');

  // The error backoff survives a toggle too.
  mode(board.id, 'manual');
  const failing = fakeEngineFor(repo);
  failing.setFail(true);
  const ap2 = createAutopilot({ repo, engine: failing.engine, settings: () => DEFAULT_APP_SETTINGS, now: () => now });
  const other = repo.createBoard({ title: 'Fails', config: { mode: 'auto', autopilotSeconds: 10, rate: { stepsPerHour: 60, usdPerDay: 100 } } });
  await ap2.tick(); await flush();
  assert.equal(ap2.status(other.id).state, 'error');
  failing.setFail(false);
  mode(other.id, 'manual'); await ap2.tick();
  mode(other.id, 'auto'); now += 15_000; await ap2.tick(); await flush();
  assert.equal(ap2.status(other.id).state, 'backoff', 'still backing off');
  assert.equal(failing.steps.length, 0);
});

test('scheduler: a step that ends after the board went manual shows manual, and the last result is kept', async () => {
  const repo = openDb(':memory:');
  let now = T;
  const { engine } = fakeEngineFor(repo);
  let settle!: { ok: () => void; fail: () => void };
  const slow = {
    ...engine,
    autoStep: () => new Promise<{ did: 'combine' }>((ok, fail) => {
      settle = { ok: () => ok({ did: 'combine' }), fail: () => fail(Object.assign(new Error('no key'), { code: 'no_key' })) };
    }),
  };
  const ap = createAutopilot({ repo, engine: slow, settings: () => DEFAULT_APP_SETTINGS, now: () => now });
  const board = repo.createBoard({ title: 'Late', config: { mode: 'auto', autopilotSeconds: 10, rate: { stepsPerHour: 60, usdPerDay: 100 } } });
  const mode = (m: 'auto' | 'manual') => repo.updateBoard(board.id, { config: { mode: m } });
  const flush = () => new Promise((r) => setTimeout(r, 5));
  const shown: string[] = [];
  engine.bus.on(board.id, (e: any) => { if (e.type === 'autopilot') shown.push(e.status.state); });

  // A step succeeds after the board went manual, before the next tick noticed.
  await ap.tick();
  mode('manual');
  settle.ok(); await flush();
  assert.deepEqual(ap.status(board.id), { state: 'manual', last: 'combine' });
  await ap.tick();
  assert.deepEqual(shown, ['running', 'manual'], 'no pace for an autopilot that is off, and manual only once');

  // Back on auto: it paces from that step, and still shows what it did last.
  mode('auto'); now += 1_000; await ap.tick();
  assert.equal(ap.status(board.id).state, 'pace');
  assert.equal(ap.status(board.id).last, 'combine');

  // A step fails after the board went manual: no error status, but the backoff still counts.
  now += 20_000; await ap.tick();
  assert.equal(ap.status(board.id).state, 'running');
  mode('manual');
  settle.fail(); await flush();
  assert.deepEqual(ap.status(board.id), { state: 'manual', last: 'combine' });
  assert.ok(!shown.includes('error'));
  mode('auto'); now += 1_000; await ap.tick();
  assert.equal(ap.status(board.id).state, 'backoff');
  assert.equal(ap.status(board.id).last, 'combine', 'the last result survives manual, error and backoff');
});
