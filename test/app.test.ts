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
import { allowedHosts, createHandler, hostGuard, hostKey, isWildcard, originKey, parseAllowedHosts } from '../server/app.ts';
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

test('the loopback and HOST names are built once per port, then reused', () => {
  let builds = 0;
  const interfaces = () => { builds++; return {}; };
  // A named HOST never needs the interfaces; a wildcard looks them up once per port while hosts match.
  const named = hostGuard({ host: 'Ideas.LAN', interfaces });
  assert.ok(named(8300, 'ideas.lan:8300') && named(8300, 'localhost:8300') && named(9000, 'ideas.lan:9000'));
  assert.ok(!named(8300, 'ideas.lan:9000'), 'each port gets its own names');
  assert.equal(builds, 0);
  const any = hostGuard({ host: '0.0.0.0', interfaces });
  for (let n = 0; n < 5; n++) assert.ok(any(8300, 'localhost:8300'));
  assert.equal(builds, 1, 'built on the first request, reused after');
});
// A machine with a LAN address and a link-local IPv6 address, which can change while we run.
function fakeInterfaces(addresses: string[]) {
  return () => ({
    lo: [{ address: '127.0.0.1', family: 'IPv4' }, { address: '::1', family: 'IPv6' }],
    eth0: addresses.map((address) => ({ address, family: address.includes(':') ? 'IPv6' : 'IPv4' })),
  }) as any;
}

test('HOST=0.0.0.0 or :: answers to this machine\'s interface addresses, and notices new ones', () => {
  for (const w of ['0.0.0.0', '::', '[::]', '0:0:0:0:0:0:0:0']) assert.ok(isWildcard(w), w);
  for (const n of ['127.0.0.1', '::1', 'ideas.lan', '10.0.0.0']) assert.ok(!isWildcard(n), n);

  const addresses = ['192.168.1.20', 'fe80::1%eth0'];
  const isOurs = hostGuard({ host: '0.0.0.0', interfaces: fakeInterfaces(addresses) });
  assert.ok(isOurs(8300, '192.168.1.20:8300'), 'the LAN address');
  assert.ok(isOurs(8300, hostKey('[fe80::1]:8300')!), 'link-local IPv6, zone id dropped');
  assert.ok(isOurs(8300, 'localhost:8300'), 'loopback names still work');
  assert.ok(!isOurs(8300, '192.168.1.21:8300'), 'another machine on the LAN');
  assert.ok(!isOurs(8300, '192.168.1.20:9000'), 'our address on another port');
  assert.ok(!isOurs(8300, 'evil.example:8300'), 'a rebound name is still refused');
  assert.ok(!isOurs(8300, '0.0.0.0:8300'), 'the wildcard is a bind, not an address');

  addresses.push('10.8.0.2'); // a VPN came up after start
  assert.ok(isOurs(8300, '10.8.0.2:8300'), 'looked up again before refusing');

  const v6 = hostGuard({ host: '::', interfaces: fakeInterfaces(['192.168.1.20']) });
  assert.ok(v6(8300, '192.168.1.20:8300'), ':: accepts IPv4 interface addresses too');
  const named = hostGuard({ host: '127.0.0.1', interfaces: fakeInterfaces(['192.168.1.20']) });
  assert.ok(!named(8300, '192.168.1.20:8300'), 'a concrete HOST does not open the interfaces');
});

test('ALLOWED_HOSTS: a bare name on any port, name:port on that port only', () => {
  const p = parseAllowedHosts(' localhost, Ideas.Example.com:443 ,::1 [fe80::2]:9000 192.168.1.20');
  assert.deepEqual([...p.names].sort(), ['192.168.1.20', '[::1]', 'localhost']);
  assert.deepEqual([...p.keys].sort(), ['[fe80::2]:9000', 'ideas.example.com:443']);
  assert.deepEqual(parseAllowedHosts(undefined), { names: new Set(), keys: new Set() });
  for (const bad of ['evil/path', 'user@host', 'a b:x'])
    assert.throws(() => parseAllowedHosts(bad), /ALLOWED_HOSTS/, bad);

  const isOurs = hostGuard({ allowedHostList: 'localhost, ideas.example.com:443' });
  assert.ok(isOurs(8300, 'localhost:9000'), 'a port forward: browser on 9000, server on 8300');
  assert.ok(isOurs(8300, 'localhost:80'));
  assert.ok(isOurs(8300, 'ideas.example.com:443'), 'a proxy in front');
  assert.ok(!isOurs(8300, 'ideas.example.com:8443'), 'name:port is that port only');
  assert.ok(!isOurs(8300, '127.0.0.1:9000'), 'only the names listed get any port');
  assert.ok(!isOurs(8300, 'evil.example:9000'));
  assert.ok(isOurs(8300, '127.0.0.1:8300'), 'the usual names still work on our port');
});

test('end to end: a port-forwarded browser and a LAN device both get the app', async () => {
  const start = async (opts: object) => {
    const s = createServer(createHandler({ repo, engine, autopilot, runtime, publicDir: join(import.meta.dirname, '..', 'public'), ...opts }));
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return { s, port: (s.address() as any).port as number };
  };
  const forwarded = await start({ allowedHostList: 'localhost' });
  const lan = await start({ host: '0.0.0.0', interfaces: fakeInterfaces(['192.168.1.20']) });
  try {
    const json = { 'Content-Type': 'application/json' };
    // ssh -L 9000:localhost:<port>: the browser says localhost:9000 in both Host and Origin.
    assert.equal((await withHost(forwarded.port, 'localhost:9000', 'GET', '/')).status, 200, 'the page');
    assert.equal((await withHost(forwarded.port, 'localhost:9000', 'POST', '/api/boards', '{"lang":"sv"}', { ...json, Origin: 'http://localhost:9000' })).status, 200, 'a write');
    assert.equal((await withHost(forwarded.port, 'evil.example:9000')).status, 403);

    // A tablet on the LAN opening http://192.168.1.20:<port>.
    const host = `192.168.1.20:${lan.port}`;
    assert.equal((await withHost(lan.port, host, 'GET', '/')).status, 200, 'the page');
    assert.equal((await withHost(lan.port, host, 'POST', '/api/boards', '{"lang":"sv"}', { ...json, Origin: `http://${host}` })).status, 200, 'a write');
    assert.equal((await withHost(lan.port, `192.168.1.99:${lan.port}`)).status, 403);
  } finally {
    forwarded.s.close();
    lan.s.close();
  }
});
