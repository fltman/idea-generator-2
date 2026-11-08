// The report and dashboard queries: medals must be the ones score.js gives
// everywhere else in the app, and days must be the local days spend is booked on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { localDay, localDays, openDb } from '../server/db.ts';
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

test('dashboard days are local days, the same ones spend is booked on', () => {
  // Far from UTC, so the local and UTC dates differ for 13 hours of every day.
  const tz = process.env.TZ;
  process.env.TZ = 'Pacific/Auckland';
  try {
    const file = join(mkdtempSync(join(tmpdir(), 'ideagen-db-')), 'days.db');
    const repo = openDb(file);
    const raw = new DatabaseSync(file);
    const board = repo.createBoard({ title: 'Dagar' });

    // Half an hour after local midnight today (or yesterday, if today is younger than that).
    const now = new Date();
    let at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 30);
    if (at > now) at = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 0, 30);
    assert.notEqual(localDay(at), at.toISOString().slice(0, 10), 'this instant is on different dates locally and in UTC');
    const idea = repo.insertIdea({ boardId: board.id, title: 'Tidig', pitch: 'p', kind: 'seed', x: 0, y: 0, generation: 0 });
    repo.setKeywords(idea.id, ['natt']);
    raw.prepare('UPDATE ideas SET created_at = ? WHERE id = ?').run(at.toISOString().slice(0, 19).replace('T', ' '), idea.id);

    const d = repo.dashboard(7);
    assert.deepEqual(d.days, localDays(7));
    assert.equal(d.days.at(-1), localDay(), 'the last day is today, the day spend is booked on');
    const series = d.keywords.find((k) => k.keyword === 'natt')!.series;
    assert.equal(series[d.days.indexOf(localDay(at))], 1, 'counted on its local day');
    assert.equal(series.reduce((a, b) => a + b, 0), 1, 'and on no other');

    // Spend booked today shows up in a one-day report: both use the same local day.
    repo.addSpend(board.id, 0.25);
    assert.equal(repo.spentOn(board.id, d.days.at(-1)), 0.25);
    assert.equal(repo.report(1).totals.spentUsd, 0.25);
    raw.close();
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

test('local days step by calendar, across a DST change', () => {
  const tz = process.env.TZ;
  process.env.TZ = 'Europe/Stockholm';
  try {
    // Summer time ended on 2026-10-25 in Sweden: that day had 25 hours.
    assert.deepEqual(localDays(3, new Date(2026, 9, 26, 0, 10)), ['2026-10-24', '2026-10-25', '2026-10-26']);
    assert.deepEqual(localDays(3, new Date(2026, 2, 30, 23, 50)), ['2026-03-28', '2026-03-29', '2026-03-30']);
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

test('dashboard: recent and previous are whole local days, matching the series', () => {
  const tz = process.env.TZ;
  process.env.TZ = 'Pacific/Auckland';
  try {
    const file = join(mkdtempSync(join(tmpdir(), 'ideagen-db-')), 'windows.db');
    const repo = openDb(file);
    const raw = new DatabaseSync(file);
    const board = repo.createBoard({ title: 'Fönster' });
    const now = new Date();
    const local = (daysAgo: number, h: number, m: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, h, m);
    const add = (title: string, at: Date) => {
      const idea = repo.insertIdea({ boardId: board.id, title, pitch: 'p', kind: 'seed', x: 0, y: 0, generation: 0 });
      repo.setKeywords(idea.id, ['kant']);
      raw.prepare('UPDATE ideas SET created_at = ? WHERE id = ?').run(at.toISOString().slice(0, 19).replace('T', ' '), idea.id);
    };
    // A two-day view: today and yesterday are recent, the two local days before are previous.
    add('today, early', local(0, 0, 30));
    add('yesterday, first minute', local(1, 0, 1));
    add('the day before, last minute', local(2, 23, 59)); // inside a rolling 48 h window, but not one of the shown days
    add('three days ago, first minute', local(3, 0, 1));
    add('four days ago, last minute', local(4, 23, 59)); // older than both windows

    const d = repo.dashboard(2);
    const k = d.keywords.find((x) => x.keyword === 'kant')!;
    assert.equal(k.count, 5);
    assert.equal(k.recent, 2, 'today and yesterday');
    assert.equal(k.previous, 2, 'the two local days before');
    assert.equal(k.series.reduce((a, b) => a + b, 0), k.recent, 'recent is exactly what the series shows');
    assert.equal(d.totals.recent, 2);
    raw.close();
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});
