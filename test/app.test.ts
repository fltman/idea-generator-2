// The request guard in app.ts: state changes are accepted only from the app's
// own page, as JSON. Everything else about the HTTP API is in api.test.ts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { createAutopilot } from '../server/autopilot.ts';
import { createHandler } from '../server/app.ts';
import { DEFAULT_APP_SETTINGS, type AppSettings } from '../server/providers.ts';

let settings: AppSettings = structuredClone(DEFAULT_APP_SETTINGS);
let pushes = 0;
const runtime = { get: () => settings, set: (s: AppSettings) => { settings = s; pushes++; }, received: () => pushes > 0 };
const repo = openDb(':memory:');
const engine = createEngine({ repo, chat: async () => { throw new Error('no LLM in this test'); }, settings: () => settings, gitInit: false });
const autopilot = createAutopilot({ repo, engine, settings: () => settings });
let server: Server;
let base = '';

before(async () => {
  server = createServer(createHandler({ repo, engine, autopilot, runtime, publicDir: join(import.meta.dirname, '..', 'public') }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

const send = (method: string, path: string, headers: Record<string, string>, body?: string) =>
  fetch(base + path, { method, headers, body });

test('a page on another site cannot change settings or boards; the app itself and plain clients can', async () => {
  const evil = { Origin: 'https://evil.example', 'Content-Type': 'application/json' };
  const settingsBody = JSON.stringify({ baseUrls: { openrouter: 'https://evil.example/collect' } });

  // Cross-site, even with the right content type: refused before the body is read.
  let res = await send('PUT', '/api/runtime-settings', evil, settingsBody);
  assert.equal(res.status, 403);
  assert.equal((await res.json()).code, 'bad_origin');
  assert.equal(pushes, 0, 'nothing reached the runtime');
  assert.equal((await send('POST', '/api/boards', evil, '{"lang":"sv"}')).status, 403);
  assert.equal((await send('DELETE', '/api/boards/1', { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await send('POST', '/api/boards', { Origin: 'null', 'Content-Type': 'application/json' }, '{}')).status, 403, 'an opaque origin is not us');

  // A cross-site request a browser can send without a CORS preflight: text/plain, no JSON.
  res = await send('POST', '/api/boards', { 'Content-Type': 'text/plain' }, '{"lang":"sv"}');
  assert.equal(res.status, 415);
  assert.equal((await res.json()).code, 'bad_content_type');
  assert.equal((await send('PUT', '/api/runtime-settings', {}, settingsBody)).status, 415, 'no content type at all');
  assert.equal(repo.listBoards().length, 0, 'no board was created');

  // The app's own page: Origin is this server. Charset parameters are fine.
  const own = { Origin: base, 'Content-Type': 'application/json; charset=utf-8' };
  res = await send('POST', '/api/boards', own, '{"lang":"sv"}');
  assert.equal(res.status, 200);
  assert.equal(repo.listBoards().length, 1);
  assert.equal((await send('PUT', '/api/runtime-settings', own, settingsBody)).status, 200);
  assert.equal(pushes, 1);
  assert.equal((await send('DELETE', '/api/boards/999', { Origin: base })).status, 200, 'DELETE carries no body, so no content type is needed');

  // A client without Origin (a shell script, these tests) is not a browser on a foreign page.
  assert.equal((await send('POST', '/api/boards', { 'Content-Type': 'application/json' }, '{"lang":"en"}')).status, 200);

  // Reads are not state changes; the browser's own same-origin policy covers them.
  assert.equal((await send('GET', '/api/boards', { Origin: 'https://evil.example' })).status, 200);
});
