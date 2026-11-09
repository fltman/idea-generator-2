// A board deleted while one of its operations waits on something else than the model
// (a page, the paper list, the disk): board and idea ids are reused, so the operation
// must write nothing into the new board that gets the same id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { writeProject } from '../server/project.ts';
import { DEFAULT_APP_SETTINGS, type ChatRequest } from '../server/providers.ts';

/** An engine whose page fetch, paper fetch and project write each wait for release(). */
function setup() {
  const repo = openDb(':memory:');
  const asked: string[] = [];
  const chat = async (r: ChatRequest) => {
    asked.push(r.schemaName);
    const value =
      r.schemaName === 'brief' ? { name: 'Bänk', slug: 'bank', oneLiner: 'o', problem: 'p', audience: 'a', mvp: ['m'], outOfScope: ['o'], stack: 's', firstSteps: ['f'], openQuestions: ['q'], risks: ['r'] }
      : r.schemaName === 'research' ? { leads: [{ id: '2610.1', title: 'Gammal lead', summary: 's', hook: 'h' }] }
      : { title: 'Gammal destillering', pitch: 'p' };
    return { value, costUsd: 0.25 };
  };
  let release!: () => void;
  const held = new Promise<void>((r) => (release = r));
  const root = mkdtempSync(join(tmpdir(), 'ideagen-deleted-'));
  const engine = createEngine({
    repo, chat, gitInit: false,
    settings: () => ({ ...structuredClone(DEFAULT_APP_SETTINGS), projectsRoot: root }),
    fetchPage: async () => (await held, { title: 'Sida', text: 'Lång text om sjungande bänkar. '.repeat(10) }),
    fetchPapers: async () => (await held, [{ id: '2610.1', title: 'Paper', summary: 's', published: '2026-11-01', upvotes: 3 }]),
    writeProject: async (a) => (await held, writeProject(a)),
  });
  /** Delete the board, create the next one (it gets the same id), and watch its events. */
  const replace = (old: { id: number }) => {
    engine.deleteBoard(old.id);
    const next = repo.createBoard({ title: 'Ny' });
    assert.equal(next.id, old.id, 'the new board gets the deleted board\'s id');
    const events: any[] = [];
    engine.bus.on(next.id, (e: any) => events.push(e));
    return { next, events };
  };
  const waiting = () => new Promise((r) => setTimeout(r, 10));
  return { repo, engine, asked, release, root, replace, waiting };
}

test('seed from a link: deleted while the page is read, no model call and no idea on the new board', async () => {
  const { repo, engine, asked, release, replace, waiting } = setup();
  const old = repo.createBoard({ title: 'Gammal' });
  const seeding = engine.seed(old.id, { text: 'https://example.com/artikel' }).then(() => null, (e: any) => e);
  await waiting();

  const { next, events } = replace(old);
  release();
  const err = await seeding;
  await engine.idle();
  assert.equal(err?.code, 'board_deleted');
  assert.match(err.message, /while the link was being read/);
  assert.deepEqual(asked, [], 'the model was not asked: the board was gone before');
  assert.deepEqual(repo.listIdeas(next.id), [], 'no idea on the new board');
  assert.deepEqual(events, []);
  assert.equal(repo.spentOn(null), 0, 'nothing spent');
});

test('research leads: deleted while the papers are fetched, no model call and no leads on the new board', async () => {
  const { repo, engine, asked, release, replace, waiting } = setup();
  const old = repo.createBoard({ title: 'Gammal', goal: 'ljud' });
  const refreshing = engine.refreshLeads(old.id, 'research').then(() => null, (e: any) => e);
  await waiting();

  const { next, events } = replace(old);
  release();
  const err = await refreshing;
  assert.equal(err?.code, 'board_deleted');
  assert.match(err.message, /while the papers were being fetched/);
  assert.deepEqual(asked, [], 'the model was not asked');
  assert.deepEqual(repo.listLeads(next.id), [], 'no leads on the new board');
  assert.deepEqual(events, []);
  assert.equal(repo.spentOn(null), 0);
});

test('project folder: deleted while it is written, the folder stays, nothing is recorded on the new board', async () => {
  const { repo, engine, asked, release, root, replace, waiting } = setup();
  const old = repo.createBoard({ title: 'Gammal' });
  const idea = repo.insertIdea({ boardId: old.id, title: 'Sjungande bänk', pitch: 'p', kind: 'seed', x: 0, y: 0, generation: 0 });
  const creating = engine.createProject(idea.id).then(() => null, (e: any) => e);
  await waiting();
  assert.deepEqual(asked, ['brief'], 'the brief is written; the folder write waits');

  const { next, events } = replace(old);
  const own = repo.insertIdea({ boardId: next.id, title: 'Egen idé', pitch: 'p', kind: 'seed', x: 0, y: 0, generation: 0 });
  assert.equal(own.id, idea.id, 'the new board\'s idea gets the old idea\'s id');
  release();
  const err = await creating;
  assert.equal(err?.code, 'board_deleted');
  const path = err.message.match(/the folder is at (.+)$/)?.[1];
  assert.ok(path?.startsWith(root), `the error says where the folder is: ${err.message}`);
  assert.ok(existsSync(path!), 'the folder stays on disk');
  assert.equal(repo.getIdea(own.id)!.projectPath, null, 'the new board\'s idea is not marked as having it');
  assert.deepEqual(events, []);
  // The brief was paid before the delete; that spend moved off the id with the board.
  assert.equal(repo.spentOn(next.id), 0, 'the new board starts with no spend');
  assert.equal(repo.spentOn(null), 0.25, 'the global total still has it');
});

test('a board delete moves its spend to no board: the next board with that id starts at zero, totals keep it', () => {
  const repo = openDb(':memory:');
  repo.addSpend(0, 0.1);
  const old = repo.createBoard({ title: 'Gammal' });
  repo.addSpend(old.id, 0.4);
  repo.addSpend(old.id, 0.05, '2026-11-01');
  assert.equal(repo.deleteBoard(old.id), true);
  const next = repo.createBoard({ title: 'Ny' });
  assert.equal(next.id, old.id);
  assert.equal(repo.spentOn(next.id), 0);
  assert.equal(repo.spentOn(0), 0.5, 'merged into the existing no-board row for today');
  assert.equal(repo.spentOn(0, '2026-11-01'), 0.05);
  assert.deepEqual(repo.spentTotal(), { usd: 0.55, calls: 3 });
  assert.equal(repo.deleteBoard(old.id + 100), false, 'deleting a board that does not exist changes nothing');
  assert.deepEqual(repo.spentTotal(), { usd: 0.55, calls: 3 });
});

test('board 0 (spend that belongs to no board) cannot be deleted: its spend stays', () => {
  const repo = openDb(':memory:');
  const engine = createEngine({ repo, chat: async () => { throw new Error('no model'); }, settings: () => DEFAULT_APP_SETTINGS, gitInit: false });
  repo.addSpend(0, 0.3);
  repo.addSpend(0, 0.2, '2026-11-01');
  assert.equal(repo.deleteBoard(0), false);
  assert.equal(engine.deleteBoard(0), false, 'the DELETE route goes through here');
  assert.equal(repo.deleteBoard(-1), false);
  assert.equal(repo.spentOn(0), 0.3, 'not doubled and not wiped');
  assert.equal(repo.spentOn(0, '2026-11-01'), 0.2);
  assert.deepEqual(repo.spentTotal(), { usd: 0.5, calls: 2 });
});

test('an old judgement on a deleted board does not clear the judging flag of a new idea with the same id', async () => {
  const repo = openDb(':memory:');
  const releases: (() => void)[] = [];
  const chat = async (_r: ChatRequest) => {
    await new Promise<void>((r) => releases.push(r));
    return { value: { reason: 'r', originality: 2, feasibility: 2, impact: 2, keywords: ['k'] }, costUsd: 0.25 };
  };
  const engine = createEngine({ repo, chat, settings: () => DEFAULT_APP_SETTINGS, gitInit: false });
  const tick = () => new Promise((r) => setTimeout(r, 10));
  const seed = (boardId: number, title: string) =>
    repo.insertIdea({ boardId, title, pitch: 'p', kind: 'seed', x: 0, y: 0, generation: 0 });

  const old = repo.createBoard({ title: 'Gammal' });
  const oldIdea = seed(old.id, 'Gammal idé');
  const oldJudging = engine.judge(oldIdea.id).then(() => null, (e: any) => e);
  await tick();
  assert.ok(engine.judging.has(oldIdea.id));

  engine.deleteBoard(old.id);
  assert.ok(!engine.judging.has(oldIdea.id), 'the deleted board\'s ideas are no longer busy');
  const next = repo.createBoard({ title: 'Ny' });
  const idea = seed(next.id, 'Ny idé');
  assert.equal(idea.id, oldIdea.id, 'the new idea gets the old idea\'s id');
  engine.queueJudge([idea.id]);
  await tick();
  assert.equal(releases.length, 2, 'the new idea is judged, not skipped as busy');
  assert.ok(engine.judging.has(idea.id));

  releases[0](); // the old judgement ends first
  assert.equal((await oldJudging)?.code, 'board_deleted');
  assert.ok(engine.judging.has(idea.id), 'the new idea is still being judged');
  engine.queueJudge([idea.id]);
  await tick();
  assert.equal(releases.length, 2, 'so it is not queued a second time');

  releases[1]();
  await engine.idle();
  assert.ok(!engine.judging.has(idea.id), 'its own judgement clears it');
  assert.equal(repo.getIdea(idea.id)!.originality, 2, "the new idea got its own judgement");
});
