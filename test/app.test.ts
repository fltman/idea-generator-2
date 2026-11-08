// The request guards in app.ts: only our own Host names are answered, and state
// changes are accepted only from the app's own page, as JSON. Everything else
// about the HTTP API is in api.test.ts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request, type Server } from 'node:http';
import { join } from 'node:path';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { createAutopilot } from '../server/autopilot.ts';
import { allowedHosts, createHandler, hostKey, hostsByPort, originKey } from '../server/app.ts';
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

// fetch() will not let us lie about Host, so this goes through node:http directly.
function withHost(port: number, host: string, method = 'GET', path = '/api/boards', body?: string, extra: Record<string, string> = {}) {
  return new Promise<{ status: number; code?: string }>((done, fail) => {
    const headers: Record<string, string> = { Host: host, ...extra };
    if (body) headers['Content-Type'] = 'application/json';
    const r = request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let code: string | undefined;
        try { code = JSON.parse(raw).code; } catch { /* static file */ }
        done({ status: res.statusCode!, code });
      });
    });
    r.on('error', fail);
    r.end(body);
  });
}

test('DNS rebinding: only our own host names are answered, on our port', async () => {
  const port = (server.address() as any).port;

  // An attacker's name resolving to 127.0.0.1: refused for reads, writes and static files alike.
  for (const [method, path, body] of [['GET', '/api/boards'], ['GET', '/api/providers'], ['GET', '/'], ['POST', '/api/boards', '{"lang":"sv"}']] as const) {
    const r = await withHost(port, `evil.example:${port}`, method, path, body);
    assert.equal(r.status, 403, `${method} ${path}`);
    if (path.startsWith('/api')) assert.equal(r.code, 'bad_host');
  }
  assert.equal((await withHost(port, 'evil.example')).status, 403, 'no port');
  assert.equal((await withHost(port, `127.0.0.1:${port + 1}`)).status, 403, 'our name on another port');
  assert.equal((await withHost(port, `127.0.0.2:${port}`)).status, 403, 'another loopback address is not one of our names');

  // Our own names, any case.
  for (const h of [`localhost:${port}`, `LocalHost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`])
    assert.equal((await withHost(port, h)).status, 200, h);

  // HOST set at start-up is accepted too, and only on our port; IPv6 literals get brackets.
  assert.ok(allowedHosts(8300, 'Ideas.LAN').has('ideas.lan:8300'));
  assert.ok(allowedHosts(8300, 'fe80::1').has('[fe80::1]:8300'));
  assert.ok(allowedHosts(80).has(hostKey('localhost')!), 'port 80 is left out of Host by browsers');
  assert.ok(!allowedHosts(8300).has(hostKey('localhost')!));
  const lan = createServer(createHandler({ repo, engine, autopilot, runtime, publicDir: join(import.meta.dirname, '..', 'public'), host: 'Ideas.LAN' }));
  await new Promise<void>((r) => lan.listen(0, '127.0.0.1', r));
  try {
    const lanPort = (lan.address() as any).port;
    assert.equal((await withHost(lanPort, `ideas.lan:${lanPort}`)).status, 200);
    assert.equal((await withHost(lanPort, `localhost:${lanPort}`)).status, 200, 'loopback names still work');
    assert.equal((await withHost(lanPort, `other.lan:${lanPort}`)).status, 403);
    assert.equal((await withHost(port, `ideas.lan:${port}`)).status, 403, 'the other server was not started with that HOST');
  } finally {
    lan.close();
  }
});

test('Host and Origin are compared in one normal form', async () => {
  // Case, default ports and IPv6 spelling all fold to the same key.
  assert.equal(hostKey('LocalHost:8300'), 'localhost:8300');
  assert.equal(hostKey('localhost'), 'localhost:80');
  assert.equal(hostKey('localhost:80'), 'localhost:80');
  assert.equal(hostKey('[0:0:0:0:0:0:0:1]:8300'), '[::1]:8300');
  assert.equal(originKey('http://LOCALHOST:8300'), 'localhost:8300');
  assert.equal(originKey('http://localhost:80'), 'localhost:80');
  assert.equal(originKey('http://localhost'), hostKey('localhost:80'));
  assert.equal(originKey('https://localhost'), 'localhost:443');
  // Not a host, not an origin.
  for (const h of [undefined, '', 'evil.example/path', 'user@localhost:8300', 'localhost:8300?x', 'local host'])
    assert.equal(hostKey(h), null, String(h));
  for (const o of [undefined, 'null', 'file:///etc', 'not a url'])
    assert.equal(originKey(o), null, String(o));

  // End to end: an upper-case Host with the matching Origin passes both guards.
  const port = (server.address() as any).port;
  const json = { 'Content-Type': 'application/json' };
  const ok = await withHost(port, `LOCALHOST:${port}`, 'POST', '/api/boards', '{"lang":"sv"}', { ...json, Origin: `http://LocalHost:${port}` });
  assert.equal(ok.status, 200, 'same host, different case');
  const ipv6 = await withHost(port, `[0:0:0:0:0:0:0:1]:${port}`, 'POST', '/api/boards', '{"lang":"sv"}', { ...json, Origin: `http://[::1]:${port}` });
  assert.equal(ipv6.status, 200, 'same IPv6 address, spelled two ways');
  const other = await withHost(port, `localhost:${port}`, 'POST', '/api/boards', '{"lang":"sv"}', { ...json, Origin: `http://127.0.0.1:${port}` });
  assert.equal(other.status, 403, 'another of our names is still another origin');
  assert.equal(other.code, 'bad_origin');
});

test('the allowed Host set is built once per port, then reused', () => {
  const allowed = hostsByPort('Ideas.LAN');
  const a = allowed(8300);
  assert.equal(allowed(8300), a, 'the same set, not a rebuilt one');
  assert.deepEqual([...a].sort(), [...allowedHosts(8300, 'Ideas.LAN')].sort());
  const b = allowed(9000);
  assert.notEqual(b, a);
  assert.ok(b.has('ideas.lan:9000') && !b.has('ideas.lan:8300'), 'each port gets its own names');
  assert.equal(allowed(9000), b);
});
