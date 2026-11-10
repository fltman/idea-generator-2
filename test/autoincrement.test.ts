// Boards and ideas have AUTOINCREMENT ids, so a deleted one's id never goes to the next
// one. A database from before is rebuilt once when it is opened (addAutoincrement in db.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.ts';

const tempFile = (name: string) => join(mkdtempSync(join(tmpdir(), 'ideagen-ids-')), name);
const TABLES = ['boards', 'ideas', 'edges', 'leads', 'idea_keywords', 'spend'];

/** A database with the schema as it was before AUTOINCREMENT: today's, without that word. */
function oldDb(file: string) {
  const template = tempFile('template.db');
  openDb(template).close();
  const t = new DatabaseSync(template);
  const statements = (t.prepare(`SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY rowid`).all() as any[])
    .map((r) => r.sql.replace(/ AUTOINCREMENT/g, ''));
  t.close();
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(statements.join(';\n'));
  return db;
}

const tableSql = (db: DatabaseSync, name: string) =>
  (db.prepare(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) as any)?.sql as string | undefined;
const dump = (db: DatabaseSync) => Object.fromEntries(TABLES.map((t) => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
const count = (db: DatabaseSync, sql: string) => (db.prepare(sql).get() as any).n as number;

/** Rows in every table that references boards or ideas, the way an old database holds them. */
function fill(db: DatabaseSync) {
  db.exec(`
    INSERT INTO boards (id, title) VALUES (1, 'Ett'), (2, 'Två'), (3, 'Tre');
    INSERT INTO ideas (id, board_id, title, kind) VALUES (1, 1, 'Frö', 'seed'), (2, 1, 'Gren', 'expand'), (4, 3, 'Sist', 'seed');
    INSERT INTO ideas (id, board_id, title, kind, origin_idea_id, origin_board_id) VALUES (3, 2, 'Gäst', 'guest', 1, 1);
    UPDATE boards SET origin_idea_id = 1 WHERE id = 2;
    INSERT INTO edges (board_id, from_id, to_id) VALUES (1, 1, 2);
    INSERT INTO idea_keywords (idea_id, keyword) VALUES (1, 'bänk'), (2, 'bänk'), (2, 'ljud');
    INSERT INTO leads (board_id, source, title, idea_id) VALUES (1, 'research', 'Paper', 2);
    INSERT INTO spend (board_id, day, usd, calls) VALUES (1, '2026-11-09', 0.5, 2), (0, '2026-11-09', 0.1, 1);
    DELETE FROM boards WHERE id = 3; -- the newest board and its idea: an old database would hand out 3 and 4 again
  `);
}

test('a new database: deleting the newest board or idea does not hand its id to the next one', () => {
  const repo = openDb(':memory:');
  const a = repo.createBoard({ title: 'A' });
  const b = repo.createBoard({ title: 'B' });
  repo.deleteBoard(b.id);
  const c = repo.createBoard({ title: 'C' });
  assert.equal(c.id, b.id + 1, 'the next board gets a new id');

  const idea = (title: string) => repo.insertIdea({ boardId: a.id, title, pitch: 'p', kind: 'seed', x: 0, y: 0, generation: 0 });
  idea('Första');
  const newest = idea('Andra');
  repo.deleteIdea(newest.id);
  assert.equal(idea('Tredje').id, newest.id + 1, 'the next idea gets a new id');
});

test('an old database is rebuilt with AUTOINCREMENT when opened: every row, reference and index kept', () => {
  const file = tempFile('old.db');
  const old = oldDb(file);
  fill(old);
  assert.doesNotMatch(tableSql(old, 'boards')!, /AUTOINCREMENT/);
  assert.equal(old.prepare(`INSERT INTO boards (title) VALUES ('Prov')`).run().lastInsertRowid, 3, 'the old schema reuses the deleted id');
  old.exec('DELETE FROM boards WHERE id = 3');
  const before = dump(old);
  old.close();

  const repo = openDb(file);
  const raw = new DatabaseSync(file);
  assert.match(tableSql(raw, 'boards')!, /id INTEGER PRIMARY KEY AUTOINCREMENT/);
  assert.match(tableSql(raw, 'ideas')!, /id INTEGER PRIMARY KEY AUTOINCREMENT/);
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'new_%'`), 0, 'no table left from the rebuild');
  assert.deepEqual(dump(raw), before, 'every row is still there, with the same ids');
  assert.deepEqual(
    (raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ideas' AND sql IS NOT NULL ORDER BY name`).all() as any[]).map((r) => r.name),
    ['ideas_board', 'ideas_guest_once'],
    'the indexes on ideas are back',
  );
  assert.deepEqual(raw.prepare('PRAGMA foreign_key_check').all(), []);

  // The sequence starts above the highest id still there. Board 3 was deleted before the
  // rebuild, which cannot know it, so 3 is handed out this once; after that, never again.
  const three = repo.createBoard({ title: 'Ny' });
  assert.equal(three.id, 3);
  repo.deleteBoard(three.id);
  assert.equal(repo.createBoard({ title: 'Nyare' }).id, 4, 'a board deleted after the rebuild keeps its id');
  const idea = () => repo.insertIdea({ boardId: 2, title: 'Ny idé', pitch: 'p', kind: 'seed', x: 0, y: 0, generation: 0 });
  const four = idea();
  assert.equal(four.id, 4);
  repo.deleteIdea(four.id);
  assert.equal(idea().id, 5, 'an idea deleted after the rebuild keeps its id');

  // Foreign keys are on again, and the other tables' references point at the new tables.
  assert.throws(() => repo.insertIdea({ boardId: 99, title: 'x', pitch: 'p', kind: 'seed', x: 0, y: 0, generation: 0 }), /FOREIGN KEY/);
  repo.deleteIdea(1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM idea_keywords WHERE idea_id = 1'), 0, 'keywords go with their idea');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM edges WHERE from_id = 1'), 0, 'edges go with their idea');
  assert.equal(repo.getBoard(2)!.originIdeaId, null, 'a spin-off board forgets its deleted origin idea');
  assert.equal(repo.getIdea(3)!.originIdeaId, null, 'a guest forgets its deleted original');
  repo.deleteBoard(1);
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM ideas WHERE board_id = 1'), 0, 'ideas go with their board');
  assert.equal(count(raw, 'SELECT COUNT(*) AS n FROM leads WHERE board_id = 1'), 0, 'leads go with their board');
  assert.equal(repo.getIdea(3)!.originBoardId, null, 'a guest forgets its deleted origin board');

  // Opening it again changes nothing.
  const after = { sql: TABLES.map((t) => tableSql(raw, t)), rows: dump(raw) };
  repo.close();
  openDb(file).close();
  assert.deepEqual({ sql: TABLES.map((t) => tableSql(raw, t)), rows: dump(raw) }, after);
  raw.close();
});

test('an old database with a broken reference keeps its schema: the rebuild is rolled back, with a warning', (t) => {
  const file = tempFile('broken.db');
  const old = oldDb(file);
  fill(old);
  old.exec('PRAGMA foreign_keys = OFF');
  old.exec(`INSERT INTO ideas (id, board_id, title, kind) VALUES (9, 77, 'Föräldralös', 'seed')`);
  const before = dump(old);
  old.close();

  const warn = t.mock.method(console, 'warn', () => {});
  const repo = openDb(file);
  assert.equal(warn.mock.callCount(), 1);
  assert.match(String(warn.mock.calls[0].arguments[0]), /1 broken reference\(s\) \(the first: ideas row 9 → boards\).*rolled back/);

  const raw = new DatabaseSync(file);
  assert.doesNotMatch(tableSql(raw, 'boards')!, /AUTOINCREMENT/, 'boards as they were');
  assert.doesNotMatch(tableSql(raw, 'ideas')!, /AUTOINCREMENT/, 'ideas as they were');
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE 'new_%'`), 0, 'no table left from the rebuild');
  assert.deepEqual(dump(raw), before, 'every row as it was');
  assert.equal(count(raw, `SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name IN ('ideas_board', 'ideas_guest_once')`), 2);

  // The app still works on it, with foreign keys on.
  assert.throws(() => repo.insertIdea({ boardId: 99, title: 'x', pitch: 'p', kind: 'seed', x: 0, y: 0, generation: 0 }), /FOREIGN KEY/);
  assert.equal(repo.createBoard({ title: 'Ny' }).id, 3, 'ids are still reused on it');
  repo.close();
  raw.close();
});
