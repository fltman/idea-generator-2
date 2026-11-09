// An idea deleted on its own (its board stays) while an operation on it waits: idea ids
// are reused, so the operation must write nothing into the next idea that gets the id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { writeProject } from '../server/project.ts';
import { DEFAULT_APP_SETTINGS, type ChatRequest } from '../server/providers.ts';

/** An engine whose model calls (and project folder writes) wait for release(). */
function setup(opts: { holdWrite?: boolean } = {}) {
  const repo = openDb(':memory:');
  const asked: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const chat = async (r: ChatRequest) => {
    asked.push(r.schemaName);
    const value =
      r.schemaName === 'brief' ? { name: 'Bänk', slug: 'bank', oneLiner: 'o', problem: 'p', audience: 'a', mvp: ['m'], outOfScope: ['o'], stack: 's', firstSteps: ['f'], openQuestions: ['q'], risks: ['r'] }
      : r.schemaName === 'expand' ? { ideas: [1, 2].map((k) => ({ title: `Gammalt barn ${k}`, pitch: 'p' })) }
      : r.schemaName === 'judgement' ? { reason: 'r', originality: 5, feasibility: 5, impact: 5, keywords: ['gammal'] }
      : { title: 'Gammal korsning', pitch: 'p' };
    if (!opts.holdWrite) await held;
    return { value, costUsd: 0.25 };
  };
  const root = mkdtempSync(join(tmpdir(), 'ideagen-idea-deleted-'));
  const engine = createEngine({
    repo, chat, gitInit: false,
    settings: () => ({ ...structuredClone(DEFAULT_APP_SETTINGS), projectsRoot: root }),
    writeProject: async (a) => (opts.holdWrite && (await held), writeProject(a)),
  });
  const board = repo.createBoard({ title: 'Tavla' });
  const events: any[] = [];
  engine.bus.on(board.id, (e: any) => events.push(e));
  const seed = (title: string, judged = false) => {
    const i = repo.insertIdea({ boardId: board.id, title, pitch: 'p', kind: 'seed', x: 0, y: 0, generation: 0 });
    if (judged) repo.saveJudgement(i.id, { originality: 3, feasibility: 3, impact: 3, reason: 'r' });
    return i;
  };
  /** Delete the idea; the next idea gets its id. Returns it and the events seen from now on. */
  const replace = (old: { id: number }) => {
    engine.deleteIdea(old.id);
    const own = seed('Egen idé');
    assert.equal(own.id, old.id, 'the new idea gets the deleted idea\'s id');
    events.length = 0;
    return own;
  };
  const waiting = () => new Promise((r) => setTimeout(r, 10));
  return { repo, engine, asked, release, board, events, seed, replace, waiting };
}

test('judge: an idea deleted while it is judged leaves the next idea with its id unjudged, and publishes nothing', async () => {
  const { repo, engine, release, board, events, seed, replace, waiting } = setup();
  const old = seed('Gammal idé');
  engine.queueJudge([old.id]);
  await waiting();
  assert.ok(engine.judging.has(old.id));

  const own = replace(old);
  assert.ok(!engine.judging.has(own.id), 'the new idea does not look busy');
  release();
  await engine.idle();
  const fresh = repo.getIdea(own.id)!;
  assert.equal(fresh.originality, null, 'not judged with the old idea\'s judgement');
  assert.deepEqual(fresh.keywords ?? [], []);
  assert.deepEqual(events, [], 'no ideas, judging or error event for the old judgement');
  assert.equal(repo.spentOn(board.id), 0.25, 'the board still paid for the call');
});

test('judge called directly: idea_deleted, not a judgement on the new idea', async () => {
  const { repo, engine, release, seed, replace, waiting } = setup();
  const old = seed('Gammal idé');
  const judging = engine.judge(old.id).then(() => null, (e: any) => e);
  await waiting();
  const own = replace(old);
  release();
  const err = await judging;
  assert.equal(err?.code, 'idea_deleted');
  assert.equal(err.status, 409);
  assert.equal(repo.getIdea(own.id)!.originality, null);
});

test('expand: a parent deleted while it is expanded gets no children, and neither does the next idea with its id', async () => {
  const { repo, engine, release, board, events, seed, replace, waiting } = setup();
  const old = seed('Gammal förälder', true);
  const expanding = engine.expand(old.id).then(() => null, (e: any) => e);
  await waiting();
  const own = replace(old);
  release();
  const err = await expanding;
  await engine.idle();
  assert.equal(err?.code, 'idea_deleted', `not a 500 from the edge foreign key: ${err?.code} ${err?.message}`);
  assert.deepEqual(repo.listIdeas(board.id).map((i) => i.title), ['Egen idé'], 'no children');
  assert.deepEqual(repo.listEdges(board.id), []);
  assert.deepEqual(events, []);
  assert.equal(repo.getIdea(own.id)!.originality, null);
});

test('combine: one parent deleted while they are combined: no child, no edges to the next idea with its id', async () => {
  const { repo, engine, release, board, events, seed, replace, waiting } = setup();
  const a = seed('Förälder A', true);
  const b = seed('Förälder B', true);
  const combining = engine.combine(board.id, a.id, b.id).then(() => null, (e: any) => e);
  await waiting();
  replace(b);
  release();
  const err = await combining;
  await engine.idle();
  assert.equal(err?.code, 'idea_deleted');
  assert.deepEqual(repo.listIdeas(board.id).map((i) => i.title), ['Förälder A', 'Egen idé']);
  assert.deepEqual(repo.listEdges(board.id), []);
  assert.deepEqual(events, []);
});

test('project: an idea deleted while its folder is written does not give the next idea with its id a project', async () => {
  const { repo, engine, asked, release, events, seed, replace, waiting } = setup({ holdWrite: true });
  const old = seed('Gammal idé', true);
  const creating = engine.createProject(old.id).then(() => null, (e: any) => e);
  await waiting();
  assert.deepEqual(asked, ['brief'], 'the brief is written; the folder write waits');
  const own = replace(old);
  release();
  const err = await creating;
  assert.equal(err?.code, 'idea_deleted');
  assert.match(err.message, /the folder is at /, 'it says where the folder is');
  assert.equal(repo.getIdea(own.id)!.projectPath, null);
  assert.deepEqual(events, []);
});

test('autopilot: a step whose idea is deleted under it ends idle, not with an error and a backoff', async () => {
  const { engine, asked, release, board, seed, replace, waiting } = setup();
  const old = seed('Ensam förälder', true); // one judged idea: the step expands it
  const step = engine.autoStep(board.id).then((r) => r, (e: any) => e);
  await waiting();
  assert.deepEqual(asked, ['expand']);
  replace(old);
  release();
  assert.deepEqual(await step, { did: 'idle', reason: 'idea_deleted' });
  await engine.idle();
});

test('deleting an idea that is not being worked on changes nothing for others', async () => {
  const { repo, engine, release, board, seed } = setup();
  release();
  const keep = seed('Behåll', true);
  const gone = seed('Radera', true);
  assert.deepEqual(engine.deleteIdea(gone.id), { ok: true });
  assert.deepEqual(engine.deleteIdea(gone.id), { ok: false }, 'twice: nothing left to delete');
  const r = await engine.expand(keep.id);
  assert.equal(r.ideas.length, 2, 'an operation on another idea goes through');
  await engine.idle();
  assert.equal(repo.listIdeas(board.id).length, 3);
});
