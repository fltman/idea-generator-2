// The Node version guard: every npm script that starts the server runs it first,
// as its own command, and on an older Node it stops with a message instead of a
// file-extension error or a "bad option" about a flag that Node does not know.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Script } from 'node:vm';

const root = join(import.meta.dirname, '..');
const GUARD_FILE = join(root, 'server', 'require-node-25.js');
const old = Number(process.versions.node.split('.')[0]) < 25;

test('every script that runs the server runs the guard first, as its own command, never through --import', () => {
  const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const servers = Object.entries(scripts).filter(([, cmd]) => cmd.includes('server/index.ts'));
  assert.deepEqual(servers.map(([name]) => name).sort(), ['dev', 'start']);
  for (const [name, cmd] of servers) {
    // `&&` stops the chain when the guard exits 1, in sh and in cmd.exe alike.
    assert.match(cmd, /^node server\/require-node-25\.js && node /, `${name} starts with the guard alone`);
    // A flag on the guard's own command line would be parsed before the guard
    // runs, and an old Node would stop on it with "bad option" instead.
    assert.doesNotMatch(cmd, /--import/, `${name} needs no flag a Node before 18.18 or 20.0 rejects`);
  }
});

test('run alone, the guard stops an old Node with a clear message and lets a new one through silently', () => {
  const r = spawnSync(process.execPath, ['server/require-node-25.js'], { cwd: root, encoding: 'utf8' });
  if (old) {
    assert.equal(r.status, 1);
    assert.match(r.stderr, /needs Node 25 or newer/);
    assert.match(r.stderr, new RegExp(`You have Node ${process.versions.node.replace(/\./g, '\\.')}`));
  } else {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
  }
  assert.equal(r.stdout, '', 'the guard prints nothing on stdout');
});

test('the guard parses on any Node: a plain script, no import or export, no syntax newer than ES2015', () => {
  const src = readFileSync(GUARD_FILE, 'utf8');
  // A classic script, the same goal CommonJS wraps in a function: import, export
  // and top-level await are syntax errors here, as they are to a Node before 12.
  assert.doesNotThrow(() => new Script(src, { filename: GUARD_FILE }), 'parses as a classic script');
  assert.doesNotThrow(() => new Script(`(function (exports, require, module, __filename, __dirname) {${src}\n})`), 'parses as CommonJS');
  const code = src.replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /\?\.|\?\?/, 'no optional chaining or nullish coalescing (Node 14+)');
});

test('an import that cannot load fails before the in-file guard runs, so the scripts must run the guard first', () => {
  // Why index.ts importing the guard is not enough: ESM links every import before running any.
  const dir = mkdtempSync(join(tmpdir(), 'ideagen-guard-'));
  const guard = pathToFileURL(GUARD_FILE).href;
  const entry = join(dir, 'entry.mjs');
  writeFileSync(entry, `import ${JSON.stringify(guard)};\nimport 'node:no-such-builtin';\nconsole.log('ran');\n`);

  const direct = spawnSync(process.execPath, [entry], { cwd: root, encoding: 'utf8' });
  assert.notEqual(direct.status, 0);
  assert.match(direct.stderr, /no-such-builtin/, 'the missing builtin is the error');
  assert.doesNotMatch(direct.stderr, /needs Node 25/, 'the guard imported first never ran');
});
