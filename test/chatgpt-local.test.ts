import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync, chmodSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localRequest } from '../server/local-request.ts';
import { fileStore } from '../server/chatgpt-store.ts';
import { signInFlow } from '../public/js/chatgpt-flow.js';

test('local requests reject foreign hosts, ports, origins, form posts and non-loopback peers', () => {
  const request = { socket: { remoteAddress: '127.0.0.1', localPort: 8300 }, method: 'POST', headers: { host: '127.0.0.1:8300', origin: 'http://127.0.0.1:8300', 'content-type': 'application/json' } };
  assert.equal(localRequest(request as any), true);
  for (const patch of [{ host: 'evil.example:8300' }, { host: '127.0.0.1:8000' }, { origin: 'https://evil.example' }, { origin: 'null' }, { 'content-type': 'text/plain' }, { 'sec-fetch-site': 'cross-site' }]) {
    assert.equal(localRequest({ ...request, headers: { ...request.headers, ...patch } } as any), false);
  }
  assert.equal(localRequest({ ...request, socket: { ...request.socket, remoteAddress: '192.168.1.2' } } as any), false);
  const navigation = { ...request, method: 'GET', headers: { host: '127.0.0.1:8300', 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' } };
  assert.equal(localRequest(navigation as any, false, true), true);
  assert.equal(localRequest(navigation as any), false);
  const callback = { ...request, method: 'GET', headers: { host: '127.0.0.1:8300', 'sec-fetch-site': 'cross-site' } };
  assert.equal(localRequest(callback as any, true), true);
  assert.equal(localRequest({ ...callback, method: 'POST' } as any, true), false);
  assert.equal(localRequest({ ...callback, headers: { host: 'localhost:8300' } } as any, true), false);
});

test('credential files are private, atomic, reloadable and locked against concurrent processes', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ideagen-auth-'));
  try {
    const store = fileStore(directory); const data = store.load();
    assert.match(data.hostId, /^urn:uuid:/);
    store.save(data); assert.equal(statSync(join(directory, 'credentials.json')).mode & 0o777, 0o600);
    assert.throws(() => fileStore(directory), /locked/);
    store.save({ ...data, welcomed: true });
    assert.equal(JSON.parse(readFileSync(join(directory, 'credentials.json'), 'utf8')).welcomed, true);
    store.close(); const reopened = fileStore(directory);
    assert.equal(reopened.load().hostId, data.hostId); reopened.close();
    chmodSync(directory, 0o755); assert.throws(() => fileStore(directory), /private permissions/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('credential storage refuses symlink roots', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ideagen-links-'));
  try { symlinkSync(directory, join(directory, 'link')); assert.throws(() => fileStore(join(directory, 'link')), /private permissions/); }
  finally { rmSync(directory, { recursive: true, force: true }); }
});

test('UI repeated clicks start once; cancel during HTTP start never navigates a stale popup', async () => {
  const calls: string[] = []; const navigations: string[] = []; let resolve!: (value: any) => void;
  const popup = { closed: false, close() { this.closed = true; }, location: { replace(url: string) { navigations.push(url); } } };
  const api = async (_method: string, path: string) => { calls.push(path); return path.endsWith('/start') ? new Promise(r => { resolve = r; }) : {}; };
  const flow = signInFlow(api, () => popup, () => {});
  const start = flow.start(); await flow.start(); assert.equal(calls.length, 1);
  const cancel = flow.cancel(); resolve({ url: '/auth/chatgpt/authorize?id=opaque', attemptId: 'opaque' });
  await Promise.all([start, cancel]);
  assert.deepEqual(navigations, []); assert.deepEqual(calls, ['/api/chatgpt/start', '/api/chatgpt/cancel']); assert.equal(flow.busy, false);
});

test('UI popup blocked or start failed leaves the flow retryable', async () => {
  let calls = 0;
  const blocked = signInFlow(async () => { calls++; }, () => null, () => {});
  await assert.rejects(blocked.start(), /popup/); assert.equal(calls, 0); assert.equal(blocked.busy, false);
  const popup = { closed: false, close() { this.closed = true; }, location: { replace() {} } };
  const failed = signInFlow(async () => { throw new Error('failed'); }, () => popup, () => {});
  await assert.rejects(failed.start(), /failed/); assert.equal(failed.busy, false); assert.equal(popup.closed, true);
});

test('an old panel cancels only its own late attempt, not a new panel’s sign-in', async () => {
  const cancelled: string[] = []; let finish!: (value: any) => void;
  const popup = { closed: false, close() { this.closed = true; }, location: { replace() {} } };
  const flow = signInFlow(async (_method, path, body) => {
    if (path.endsWith('/start')) return new Promise(r => { finish = r; });
    cancelled.push(body.attemptId);
  }, () => popup, () => {});
  const start = flow.start(); const cancel = flow.cancel('new-panel-attempt');
  finish({ url: '/auth/chatgpt/authorize?id=old', attemptId: 'old-panel-attempt' });
  await Promise.all([start, cancel]); assert.deepEqual(cancelled, ['old-panel-attempt']);
});
