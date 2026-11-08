// The Node version guard: every npm script that starts the server preloads it,
// and on an older Node it stops with a message instead of a file-extension error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const GUARD = '--import ./server/require-node-25.js';

test('every script that runs the server preloads the Node version guard', () => {
  const { scripts } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };
  const servers = Object.entries(scripts).filter(([, cmd]) => cmd.includes('server/index.ts'));
  assert.deepEqual(servers.map(([name]) => name).sort(), ['dev', 'start']);
  for (const [name, cmd] of servers) assert.ok(cmd.includes(GUARD) && cmd.indexOf(GUARD) < cmd.indexOf('server/index.ts'), `${name} preloads the guard`);
});

test('the guard stops an old Node with a clear message, and lets a new one through', () => {
  const r = spawnSync(process.execPath, ['--import', './server/require-node-25.js', '-e', 'console.log("started")'], { cwd: root, encoding: 'utf8' });
  if (Number(process.versions.node.split('.')[0]) < 25) {
    assert.equal(r.status, 1);
    assert.match(r.stderr, /needs Node 25 or newer/);
    assert.match(r.stderr, new RegExp(`You have Node ${process.versions.node.replace(/\./g, '\\.')}`));
    assert.equal(r.stdout, '', 'nothing after the guard ran');
  } else {
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'started');
  }
});
