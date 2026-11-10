// Boards and ideas have AUTOINCREMENT ids, so a deleted one's id is not handed out again.
// The guards against an operation, a page or a timer reaching the next board or idea with
// the same id stay as a second line: a database whose rebuild was rolled back (see
// addAutoincrement in db.ts) still reuses ids. Tests of those guards use this database,
// which reuses them the way the old schema did: after every delete the id sequence is
// forgotten, so the next board or idea gets the highest id still there + 1.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.ts';

export function openDbReusingIds() {
  const file = join(mkdtempSync(join(tmpdir(), 'ideagen-reused-')), 'reused.db');
  const repo = openDb(file);
  const raw = new DatabaseSync(file);
  raw.exec(`
    CREATE TRIGGER reuse_board_ids AFTER DELETE ON boards BEGIN DELETE FROM sqlite_sequence WHERE name IN ('boards', 'ideas'); END;
    CREATE TRIGGER reuse_idea_ids AFTER DELETE ON ideas BEGIN DELETE FROM sqlite_sequence WHERE name = 'ideas'; END;
  `);
  raw.close();
  return repo;
}
