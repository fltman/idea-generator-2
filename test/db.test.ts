// The report and dashboard queries: medals must be the ones score.js gives
// everywhere else in the app, and days must be the local days spend is booked on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { dayOf, localDay, localDayRanges, localDays, openDb, wholeDays } from '../server/db.ts';
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

test('report: new ideas are counted over the same local days as its spend', () => {
  const tz = process.env.TZ;
  process.env.TZ = 'Pacific/Auckland';
  try {
    const file = join(mkdtempSync(join(tmpdir(), 'ideagen-db-')), 'report.db');
    const repo = openDb(file);
    const raw = new DatabaseSync(file);
    const board = repo.createBoard({ title: 'Rapport' });
    const now = new Date();
    const local = (daysAgo: number, h: number, m: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, h, m);
    const add = (title: string, at: Date) => {
      const idea = repo.insertIdea({ boardId: board.id, title, pitch: 'p', kind: 'seed', x: 0, y: 0, generation: 0 });
      raw.prepare('UPDATE ideas SET created_at = ? WHERE id = ?').run(at.toISOString().slice(0, 19).replace('T', ' '), idea.id);
    };
    // A one-day report covers today from local midnight.
    add('today, first minute', local(0, 0, 1));
    add('yesterday, last minute', local(1, 23, 59)); // inside a rolling 24 h window for most of the day
    add('yesterday, noon', local(1, 12, 0));
    repo.addSpend(board.id, 0.5);

    const r = repo.report(1);
    assert.equal(r.totals.newIdeas, 1, 'only today');
    assert.equal(r.boards[0].newIdeas, 1);
    assert.equal(r.totals.spentUsd, 0.5, 'spend booked today, same period');
    assert.equal(repo.report(2).totals.newIdeas, 3, 'two days: today and all of yesterday');
    assert.equal(r.totals.newIdeas, repo.dashboard(1).totals.recent, 'the dashboard agrees for the same number of days');
    raw.close();
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

test('dashboard series: counted in SQLite on whole local days, across DST and odd offsets, for the keywords shown', () => {
  const tz = process.env.TZ;
  try {
    for (const zone of ['Europe/Stockholm', 'Pacific/Auckland', 'America/St_Johns', 'Asia/Kathmandu']) {
      process.env.TZ = zone;
      const file = join(mkdtempSync(join(tmpdir(), 'ideagen-db-')), 'series.db');
      const repo = openDb(file);
      const raw = new DatabaseSync(file);
      const board = repo.createBoard({ title: 'Serie' });
      const now = new Date();
      const midnight = (daysAgo: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo);
      const stored: { keyword: string; at: string }[] = [];
      const add = (keyword: string, at: Date) => {
        const idea = repo.insertIdea({ boardId: board.id, title: keyword, pitch: 'p', kind: 'seed', x: 0, y: 0, generation: 0 });
        repo.setKeywords(idea.id, [keyword]);
        const s = at.toISOString().slice(0, 19).replace('T', ' ');
        raw.prepare('UPDATE ideas SET created_at = ? WHERE id = ?').run(s, idea.id);
        stored.push({ keyword, at: s });
      };
      // A year and a bit of ideas at pseudo-random times (both DST changes fall inside),
      // plus the edges of many local days: the first second of a day and the last one before it.
      let seed = 7;
      const rand = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
      const words = ['sol', 'vind', 'vatten', 'jord'];
      for (let n = 0; n < 400; n++) add(words[n % 3], new Date(now.getTime() - rand() * 380 * 86_400_000));
      for (const ago of [0, 1, 2, 30, 90, 150, 200, 250, 300, 364, 365]) {
        add('sol', midnight(ago));
        add('vind', new Date(midnight(ago).getTime() - 1000));
      }
      add('jord', midnight(1)); // a rare keyword, below the limit of three below

      const days = 365;
      const d = repo.dashboard(days, 3);
      assert.equal(d.days.length, days);
      assert.deepEqual(d.keywords.map((k) => k.keyword).sort(), ['sol', 'vatten', 'vind'], 'jord is not shown');
      // The reference: each stored instant on its own local day, in JS.
      const index = new Map(d.days.map((day, n) => [day, n]));
      for (const k of d.keywords) {
        const expected = d.days.map(() => 0);
        for (const s of stored) {
          if (s.keyword !== k.keyword) continue;
          const at = index.get(localDay(new Date(`${s.at.replace(' ', 'T')}Z`)));
          if (at !== undefined) expected[at]++;
        }
        assert.deepEqual(k.series, expected, `${zone}: ${k.keyword}`);
        assert.equal(k.series.reduce((a, b) => a + b, 0), k.recent, `${zone}: ${k.keyword} recent matches its series`);
      }
      raw.close();
    }
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

test('a fractional number of days is rounded inside db.ts too: today stays in, and the previous period matches', () => {
  for (const [asked, whole] of [[2.5, 3], [2.4, 2], [1.5, 2], [0.4, 1], [0, 1], [-3, 1], [NaN, 1], [7, 7]] as const)
    assert.equal(wholeDays(asked), whole, String(asked));
  const today = localDay();
  for (const asked of [0.5, 1.5, 2.5, 6.6]) {
    const days = localDays(asked);
    assert.equal(days.length, wholeDays(asked), `${asked}: whole days`);
    assert.equal(days.at(-1), today, `${asked}: ends today`);
  }

  // Straight to the repo, past the HTTP clamp: the same answer as the whole number.
  const file = join(mkdtempSync(join(tmpdir(), 'ideagen-db-')), 'fraction.db');
  const repo = openDb(file);
  const raw = new DatabaseSync(file);
  const board = repo.createBoard({ title: 'Bråk' });
  const now = new Date();
  for (const ago of [0, 1, 2, 3, 4, 5, 6]) {
    const idea = repo.insertIdea({ boardId: board.id, title: `d${ago}`, pitch: 'p', kind: 'seed', x: 0, y: 0, generation: 0 });
    repo.setKeywords(idea.id, ['dag']);
    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ago, 12);
    raw.prepare('UPDATE ideas SET created_at = ? WHERE id = ?').run(at.toISOString().slice(0, 19).replace('T', ' '), idea.id);
  }
  const d = repo.dashboard(2.5);
  assert.deepEqual(d, repo.dashboard(3), 'dashboard(2.5) is dashboard(3)');
  const dag = d.keywords.find((k) => k.keyword === 'dag')!;
  assert.deepEqual(dag.series, [1, 1, 1], 'three days, today last');
  assert.equal(dag.previous, 3, 'the previous period is three whole days too');
  const r = repo.report(2.5);
  assert.equal(r.days, 3);
  assert.deepEqual(r, repo.report(3), 'report(2.5) is report(3)');
  raw.close();
});

test('dayOf: binary search over day starts, the last start at or before the instant', () => {
  const starts = ['2026-11-05 23:00:00', '2026-11-06 23:00:00', '2026-11-07 23:00:00'];
  assert.equal(dayOf(starts, '2026-11-05 22:59:59'), -1, 'before the first day');
  assert.equal(dayOf(starts, '2026-11-05 23:00:00'), 0, 'the first second of day 0');
  assert.equal(dayOf(starts, '2026-11-06 22:59:59'), 0, 'the last second of day 0');
  assert.equal(dayOf(starts, '2026-11-06 23:00:00'), 1);
  assert.equal(dayOf(starts, '2026-11-07 12:00:00'), 1);
  assert.equal(dayOf(starts, '2026-11-08 22:59:59'), 2, 'the last day has no stop of its own; the query bounds it');
  assert.equal(dayOf([], '2026-11-07 12:00:00'), -1);
  // Against a linear scan, for every list length up to 40 and instants on and around each start.
  for (let len = 1; len <= 40; len++) {
    const list = Array.from({ length: len }, (_, n) => `2026-01-${String(n + 1).padStart(2, '0')} 00:00:00`);
    for (const s of list)
      for (const at of [s, s.replace('00:00:00', '12:00:00'), s.replace(' 00:00:00', ' -')]) {
        let linear = -1;
        list.forEach((start, n) => { if (start <= at) linear = n; });
        assert.equal(dayOf(list, at), linear, `${len} days, ${at}`);
      }
  }
});

test('dashboard series: the same counts as the range join it replaced, on the same rows', () => {
  const tz = process.env.TZ;
  try {
    for (const zone of ['Europe/Stockholm', 'Asia/Kathmandu']) {
      process.env.TZ = zone;
      const file = join(mkdtempSync(join(tmpdir(), 'ideagen-db-')), 'same-counts.db');
      const repo = openDb(file);
      const raw = new DatabaseSync(file);
      const board = repo.createBoard({ title: 'Samma' });
      const add = (keywords: string[], at: string) => {
        const idea = repo.insertIdea({ boardId: board.id, title: keywords.join(' '), pitch: 'p', kind: 'seed', x: 0, y: 0, generation: 0 });
        repo.setKeywords(idea.id, keywords);
        raw.prepare('UPDATE ideas SET created_at = ? WHERE id = ?').run(at, idea.id);
      };
      const days = 120;
      const ranges = localDayRanges(localDays(days));
      const sql = (ms: number) => new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
      const ms = (s: string) => new Date(`${s.replace(' ', 'T')}Z`).getTime();
      let seed = 11;
      const rand = () => ((seed = (seed * 48271) % 2147483647) / 2147483647);
      const words = ['sol', 'vind', 'vatten', 'jord', 'eld'];
      const span = ms(ranges[days - 1][1]) - ms(ranges[0][0]);
      for (let n = 0; n < 600; n++) {
        const at = sql(ms(ranges[0][0]) - 5 * 86_400_000 + rand() * (span + 10 * 86_400_000));
        add([words[n % 5], words[(n * 3 + 1) % 5]].filter((w, i, a) => a.indexOf(w) === i), at);
      }
      for (const [start, stop] of ranges.filter((_, n) => n % 7 === 0)) {
        add(['sol'], start);
        add(['sol', 'vind'], start); // two ideas at the same instant
        add(['vind'], sql(ms(stop) - 1000));
        add(['eld'], `${start}.250`); // a value with fractional seconds
        add(['eld'], start.replace(' ', 'T')); // and one with a T, which sorts after a space
      }

      const d = repo.dashboard(days, 4);
      // The query this replaced, run on the same database and keywords.
      const old = raw
        .prepare(
          `WITH days AS (SELECT CAST(key AS INTEGER) AS n, json_extract(value, '$[0]') AS start, json_extract(value, '$[1]') AS stop
                         FROM json_each(?))
           SELECT k.keyword, d.n AS day, COUNT(*) AS count
           FROM idea_keywords k
           JOIN ideas i ON i.id = k.idea_id
           JOIN days d ON i.created_at >= d.start AND i.created_at < d.stop
           WHERE i.created_at >= ? AND i.created_at < ? AND k.keyword IN (SELECT value FROM json_each(?))
           GROUP BY k.keyword, d.n`,
        )
        .all(JSON.stringify(ranges), ranges[0][0], ranges[days - 1][1], JSON.stringify(d.keywords.map((k) => k.keyword))) as any[];
      assert.equal(d.keywords.length, 4);
      for (const k of d.keywords) {
        const expected = d.days.map(() => 0);
        for (const r of old) if (r.keyword === k.keyword) expected[r.day] = r.count;
        assert.ok(expected.some((n) => n > 0), `${zone}: ${k.keyword} has ideas in the window`);
        assert.deepEqual(k.series, expected, `${zone}: ${k.keyword}`);
      }
      raw.close();
    }
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

test('local day ranges: one [start, stop) pair per day, no gap or overlap, 23 or 25 hours across DST', () => {
  const tz = process.env.TZ;
  const fromSql = (s: string) => new Date(`${s.replace(' ', 'T')}Z`);
  try {
    // Stockholm: spring forward on 29 March 2026, fall back on 25 October 2026.
    process.env.TZ = 'Europe/Stockholm';
    const days = localDays(400, new Date(2026, 10, 8, 12));
    const ranges = localDayRanges(days);
    assert.equal(ranges.length, days.length);
    const hours = new Map<string, number>();
    ranges.forEach(([start, stop], n) => {
      assert.ok(start < stop, `${days[n]}: start before stop`);
      if (n + 1 < ranges.length) assert.equal(stop, ranges[n + 1][0], `${days[n]} stops where the next day starts`);
      assert.equal(localDay(fromSql(start)), days[n], `${days[n]}: the first second is that day`);
      assert.equal(localDay(new Date(fromSql(stop).getTime() - 1000)), days[n], `${days[n]}: the last second is that day`);
      hours.set(days[n], (fromSql(stop).getTime() - fromSql(start).getTime()) / 3_600_000);
    });
    assert.equal(hours.get('2026-03-29'), 23, 'spring forward');
    assert.equal(hours.get('2026-10-25'), 25, 'fall back');
    assert.equal([...hours.values()].filter((h) => h !== 24).length, 3, 'each DST change once: October 2025, March and October 2026');
    assert.deepEqual(localDayRanges(['2026-11-08']), [['2026-11-07 23:00:00', '2026-11-08 23:00:00']]);

    // The dashboard counts over those ranges: an idea at the last second of today is in
    // today's series; one at tomorrow's first second is in recent but in no day.
    process.env.TZ = 'Asia/Kathmandu';
    const file = join(mkdtempSync(join(tmpdir(), 'ideagen-db-')), 'ranges.db');
    const repo = openDb(file);
    const raw = new DatabaseSync(file);
    const board = repo.createBoard({ title: 'Gränser' });
    const today = localDayRanges(localDays(1))[0];
    const at = (keyword: string, sql: string) => {
      const idea = repo.insertIdea({ boardId: board.id, title: keyword, pitch: 'p', kind: 'seed', x: 0, y: 0, generation: 0 });
      repo.setKeywords(idea.id, [keyword]);
      raw.prepare('UPDATE ideas SET created_at = ? WHERE id = ?').run(sql, idea.id);
    };
    const shift = (sql: string, seconds: number) => new Date(fromSql(sql).getTime() + seconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
    at('kant', today[0]);
    at('kant', shift(today[1], -1));
    at('kant', today[1]);
    at('kant', shift(today[0], -1));
    const d = repo.dashboard(1, 5);
    const kant = d.keywords.find((k) => k.keyword === 'kant')!;
    assert.deepEqual(kant.series, [2], 'the first and last second of today');
    assert.equal(kant.recent, 3, 'recent has no upper bound');
    assert.equal(kant.previous, 1, 'the last second of yesterday');
    assert.equal(d.totals.recent, 3);
    raw.close();
  } finally {
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});

test('report: one read of the ideas table, the same local days and score.js medals', () => {
  const tz = process.env.TZ;
  process.env.TZ = 'America/St_Johns'; // UTC-3:30 or -2:30: local midnight is never a whole UTC hour
  const prepare = DatabaseSync.prototype.prepare;
  try {
    const file = join(mkdtempSync(join(tmpdir(), 'ideagen-db-')), 'report-once.db');
    const repo = openDb(file);
    const raw = new DatabaseSync(file);
    const a = repo.createBoard({ title: 'Ett' });
    const b = repo.createBoard({ title: 'Två' });
    const start = new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - 1); // the first local day of a 2-day report
    const sql = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');
    const add = (board: number, at: Date, scores?: [number, number, number]) => {
      const idea = repo.insertIdea({ boardId: board, title: 't', pitch: 'p', kind: 'seed', x: 0, y: 0, generation: 0 });
      if (scores) repo.saveJudgement(idea.id, { originality: scores[0], feasibility: scores[1], impact: scores[2], reason: 'r' });
      raw.prepare('UPDATE ideas SET created_at = ? WHERE id = ?').run(sql(at), idea.id);
      return idea.id;
    };
    add(a.id, start, [5, 5, 5]); // the first second of the period: new, gold
    add(a.id, new Date(start.getTime() - 1000), [4, 4, 3]); // the last second before it: old, silver
    add(b.id, new Date(start.getTime() + 12 * 3_600_000), [3, 3, 3]); // inside, bronze
    add(b.id, new Date(start.getTime() - 40 * 86_400_000), [1, 1, 1]); // long ago, no medal

    const reads: string[] = [];
    DatabaseSync.prototype.prepare = function (this: DatabaseSync, text: string) {
      if (/\bFROM ideas\b/.test(text)) reads.push(text);
      return prepare.call(this, text);
    } as typeof prepare;
    const r = repo.report(2);
    DatabaseSync.prototype.prepare = prepare;

    assert.equal(reads.length, 1, `the ideas table is read once:\n${reads.join('\n---\n')}`);
    assert.equal(r.totals.ideas, 4);
    assert.equal(r.totals.newIdeas, 2, 'from local midnight of the first day, that second included');
    assert.equal(r.totals.newIdeas, repo.dashboard(2).totals.recent, 'the same days as the dashboard');
    assert.deepEqual(Object.fromEntries(r.boards.map((x) => [x.title, x.newIdeas])), { Ett: 1, Två: 1 });
    assert.deepEqual(r.totals.medals, { gold: 1, silver: 1, bronze: 1 });
    for (const x of r.boards) for (const i of x.best) assert.equal(i.medal, medalFromSum(i.sum), `${i.id}: medal from score.js`);
    raw.close();
  } finally {
    DatabaseSync.prototype.prepare = prepare;
    if (tz === undefined) delete process.env.TZ;
    else process.env.TZ = tz;
  }
});
