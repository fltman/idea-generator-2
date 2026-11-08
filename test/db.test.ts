// The report query against an in-memory database: medals must be the ones score.js
// gives everywhere else in the app, thresholds included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../server/db.ts';
import { MEDAL_MIN_SUM, medal, medalFromSum } from '../public/js/score.js';

test('report: medals come from score.js, so a threshold change moves the report too', () => {
  const repo = openDb(':memory:');
  const board = repo.createBoard({ title: 'Medaljer' });
  const add = (title: string, scores?: [number, number, number], override?: number) => {
    const idea = repo.insertIdea({ boardId: board.id, title, pitch: 'p', kind: 'seed', x: 0, y: 0, generation: 0 });
    if (scores) repo.saveJudgement(idea.id, { originality: scores[0], feasibility: scores[1], impact: scores[2], reason: 'r' });
    if (override !== undefined) repo.setMedalOverride(idea.id, override);
    return repo.getIdea(idea.id)!;
  };
  // One idea exactly on each threshold, one just under bronze, one unjudged, and two hand-set medals.
  add('gold', [5, 5, 3]);
  add('silver', [4, 4, 3]);
  add('bronze', [3, 3, 3]);
  add('none', [3, 3, 2]);
  add('unjudged');
  add('weak but gold by hand', [1, 1, 1], 3);
  add('strong but demoted', [5, 5, 5], 0);

  const r = repo.report(30);
  assert.deepEqual(r.totals.medals, { gold: 2, silver: 1, bronze: 1 });
  const best = r.boards[0].best;
  assert.deepEqual(best.map((b) => b.title), ['strong but demoted', 'gold', 'silver'], 'ranked by sum, not by medal');
  assert.deepEqual(best.map((b) => b.medal), [0, 3, 2]);
  assert.equal(best[1].sum, MEDAL_MIN_SUM[3]);
  assert.equal(best[1].medal, medalFromSum(MEDAL_MIN_SUM[3]));
  // Every reported medal equals what the browser computes for the same idea.
  for (const b of best) assert.equal(b.medal, medal(repo.getIdea(b.id)));
});
