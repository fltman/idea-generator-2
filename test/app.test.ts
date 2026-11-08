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
import {
  allowedHosts, arrivalKey, badOriginMessage, createHandler, hostGuard, hostKey, hostKeys, hostNote, isWildcard, machineNames, originKey,
  parseAllowedHosts, PROXY_HINT,
} from '../server/app.ts';
import { connect } from 'node:net';
import { hostname, networkInterfaces } from 'node:os';
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
function withHost(port: number, host: string, method = 'GET', path = '/api/boards', body?: string, extra: Record<string, string> = {}, address = '127.0.0.1') {
  return new Promise<{ status: number; code?: string; error?: string }>((done, fail) => {
    const headers: Record<string, string> = { Host: host, ...extra };
    if (body) headers['Content-Type'] = 'application/json';
    const r = request({ host: address, port, method, path, headers }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => {
        let code: string | undefined;
        let error: string | undefined;
        try { ({ code, error } = JSON.parse(raw)); } catch { /* static file */ }
        done({ status: res.statusCode!, code, error });
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
  const elsewhere = await withHost(port, `localhost:${port}`, 'POST', '/api/boards', '{"lang":"sv"}', { ...json, Origin: `http://localhost:${port + 1}` });
  assert.equal(elsewhere.status, 403, 'our name on another port is another app');
  assert.equal(elsewhere.code, 'bad_origin');
});

test('a refused write points to the proxy fix only when Host is loopback and the Origin is not', () => {
  const hinted = (origin: string, host: string) => /reverse proxy/.test(badOriginMessage(origin, originKey(origin), host));
  // nginx's default proxy_pass: Host is the upstream, the Origin is the public page.
  for (const host of ['127.0.0.1:8300', 'localhost:8300', '[::1]:8300', '127.0.0.2:8300', 'app.localhost:8300', 'LOCALHOST:8300'])
    assert.ok(hinted('https://ideas.example.com', host), host);
  assert.match(badOriginMessage('https://[2001:db8::5]', originKey('https://[2001:db8::5]'), '127.0.0.1:8300'), /list \[2001:db8::5\] in ALLOWED_HOSTS/);
  // Another local server, an opaque origin, a public Host, no Host: just refused.
  assert.ok(!hinted('http://localhost:5173', 'localhost:8300'), 'another local app');
  assert.ok(!hinted('http://127.0.0.1:8300', 'localhost:8300'), 'another of our loopback names');
  assert.ok(!hinted('null', '127.0.0.1:8300'), 'an opaque origin');
  assert.ok(!hinted('https://evil.example', 'ideas.example.com'), 'a public Host');
  assert.ok(!hinted('https://evil.example', ''), 'no Host');
  assert.equal(badOriginMessage('https://evil.example', originKey('https://evil.example'), 'ideas.example.com'), 'Requests from https://evil.example are not accepted');
});

test('the start-up note says what a reverse proxy needs, with or without ALLOWED_HOSTS', () => {
  assert.equal(hostNote(undefined), PROXY_HINT);
  assert.equal(hostNote(''), PROXY_HINT);
  assert.match(PROXY_HINT, /proxy_set_header Host \$host;.*ALLOWED_HOSTS/);
  const set = hostNote('ideas.example.com, box:8443');
  assert.match(set, /ALLOWED_HOSTS: ideas\.example\.com, box:8443\./);
  assert.match(set, /proxy_set_header Host \$host;/);
  assert.match(set, /403 bad_origin/);
});

/** hostKeys as it was, with two extra URL parses to learn whether a port was written: the reference. */
function hostKeysByThreeParses(header: string | undefined): string[] {
  const key = hostKey(header);
  if (!key) return [];
  const writesPort = new URL(`http://${header}`).port !== '' || new URL(`https://${header}`).port !== '';
  return writesPort ? [key] : [key, `${key.slice(0, key.lastIndexOf(':'))}:443`];
}

/** Count `new URL` calls while f runs. */
async function urlParses(f: () => unknown) {
  const Real = globalThis.URL;
  let n = 0;
  globalThis.URL = new Proxy(Real, { construct: (target, args) => (n++, Reflect.construct(target, args)) });
  try {
    await f();
  } finally {
    globalThis.URL = Real;
  }
  return n;
}

test('hostKeys reads "has a port" off the header: the same keys as parsing it as http and https', () => {
  const tricky = [
    'name', 'name:80', 'name:443', 'name:8300', 'name:080', 'name:0', 'name:', 'NAME:80', 'name:65535', 'name:65536',
    'name/', 'name:80/', 'name?', 'name:80?', 'name#', 'name:80#', 'name\\', 'name:80\\', 'name:80/./', 'name:80/..', 'name:80/%2e',
    'name:80 ', 'name:80\t', 'na\tme:80', 'name:8\t0', 'name:\n80', 'name\r:443', ' name', 'name:80\x01',
    '[::1]', '[::1]:80', '[::1]:', '[0:0::1]:443', '[::ffff:127.0.0.1]:8300', '127.1', '127.1:80', '0x7f.1:443', '%41', 'xn--bcher-kva.example:80',
    'user@name:80', 'name:80/path', 'name:abc', 'name:80:80', '', ':80', '[::1', 'name:80?q',
    // The parser skips any run of / and \ after "http://": found by the random headers below.
    '\\1:1?', '/name:80', '\\\\name:443/', '/\\/name', '\t/name:80', '/\tname:8300',
  ];
  for (const h of tricky) assert.deepEqual(hostKeys(h), hostKeysByThreeParses(h), JSON.stringify(h));
  // And random headers over the characters that matter.
  let seed = 3;
  const rand = (n: number) => ((seed = (seed * 48271) % 2147483647) % n);
  const alphabet = ['a', 'b', 'Z', '0', '8', ':', ':', '.', '/', '?', '#', '\\', '[', ']', '\t', '\n', ' ', '@', '%', '1'];
  for (let i = 0; i < 20_000; i++) {
    const h = Array.from({ length: 1 + rand(10) }, () => alphabet[rand(alphabet.length)]).join('');
    assert.deepEqual(hostKeys(h), hostKeysByThreeParses(h), JSON.stringify(h));
  }
});

test('one URL parse per Host header, and one hostKeys per request for both guards', async () => {
  assert.equal(await urlParses(() => hostKeys('ideas.example.com')), 1);
  assert.equal(await urlParses(() => hostKeys('ideas.example.com:443')), 1);
  // A write through the handler: req.url, the Host header once, the Origin once, then
  // the 404 for an unknown route. Before, Host was parsed three times in each guard.
  const port = (server.address() as any).port;
  const write = () => withHost(port, `localhost:${port}`, 'POST', '/api/no-such-route', '{}', { Origin: `http://localhost:${port}` });
  assert.equal((await write()).status, 404, 'past both guards'); // warm: the allowed names are built once per port
  assert.equal(await urlParses(write), 3);
});

test('the loopback and HOST names are per port', () => {
  const named = hostGuard({ host: 'Ideas.LAN' });
  assert.ok(named(8300, 'ideas.lan:8300') && named(8300, 'localhost:8300') && named(9000, 'ideas.lan:9000'));
  assert.ok(!named(8300, 'ideas.lan:9000'), 'each port gets its own names');
  assert.ok(!allowedHosts(8300, '0.0.0.0').has('0.0.0.0:8300') && !allowedHosts(8300, '::').has('[::]:8300'), 'a wildcard is not a name');
});

test('HOST=0.0.0.0 or :: answers to the address each connection arrived on', () => {
  for (const w of ['0.0.0.0', '::', '[::]', '0:0:0:0:0:0:0:0']) assert.ok(isWildcard(w), w);
  for (const n of ['127.0.0.1', '::1', 'ideas.lan', '10.0.0.0']) assert.ok(!isWildcard(n), n);

  // What a browser that reached us at that address sends as Host.
  assert.equal(arrivalKey('192.168.1.20', 8300), '192.168.1.20:8300');
  assert.equal(arrivalKey('::ffff:192.168.1.20', 8300), '192.168.1.20:8300', 'IPv4 on a dual-stack socket');
  assert.equal(arrivalKey('::FFFF:10.8.0.2', 8300), '10.8.0.2:8300');
  assert.equal(arrivalKey('fe80::1%15', 8300), '[fe80::1]:8300', 'zone id dropped');
  assert.equal(arrivalKey('2001:0db8:0:0:0:0:0:1', 8300), '[2001:db8::1]:8300', 'compressed like the Host');
  for (const bad of [undefined, '', '0.0.0.0', '::', 'not-an-ip']) assert.equal(arrivalKey(bad, 8300), null, String(bad));

  for (const bind of ['0.0.0.0', '::']) {
    const isOurs = hostGuard({ host: bind });
    assert.ok(isOurs(8300, '192.168.1.20:8300', '192.168.1.20'), `${bind}: the address it arrived on`);
    assert.ok(isOurs(8300, '192.168.1.20:8300', '::ffff:192.168.1.20'), `${bind}: the same, IPv4-mapped`);
    assert.ok(isOurs(8300, '10.8.0.2:8300', '10.8.0.2'), `${bind}: a VPN address that came up a moment ago`);
    assert.ok(isOurs(8300, '[fe80::1]:8300', 'fe80::1%eth0'), `${bind}: link-local IPv6`);
    assert.ok(isOurs(8300, 'localhost:8300', '192.168.1.20'), `${bind}: loopback names still work`);
    assert.ok(!isOurs(8300, '192.168.1.21:8300', '192.168.1.20'), `${bind}: another address than the one it arrived on`);
    assert.ok(!isOurs(8300, '192.168.1.20:9000', '192.168.1.20'), `${bind}: our address on another port`);
    assert.ok(!isOurs(8300, 'evil.example:8300', '192.168.1.20'), `${bind}: a rebound name is still refused`);
    assert.ok(!isOurs(8300, '0.0.0.0:8300', '0.0.0.0'), `${bind}: the wildcard is a bind, not an address`);
    assert.ok(!isOurs(8300, '192.168.1.20:8300'), `${bind}: no arrival address, no match`);
  }
  const named = hostGuard({ host: '127.0.0.1' });
  assert.ok(!named(8300, '192.168.1.20:8300', '192.168.1.20'), 'a concrete HOST does not accept the arrival address');
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

test('end to end: a port-forwarded browser gets the app', async () => {
  const forwarded = createServer(createHandler({ repo, engine, autopilot, runtime, publicDir: join(import.meta.dirname, '..', 'public'), allowedHostList: 'localhost' }));
  await new Promise<void>((r) => forwarded.listen(0, '127.0.0.1', r));
  const port = (forwarded.address() as any).port as number;
  try {
    const json = { 'Content-Type': 'application/json' };
    // ssh -L 9000:localhost:<port>: the browser says localhost:9000 in both Host and Origin.
    assert.equal((await withHost(port, 'localhost:9000', 'GET', '/')).status, 200, 'the page');
    assert.equal((await withHost(port, 'localhost:9000', 'POST', '/api/boards', '{"lang":"sv"}', { ...json, Origin: 'http://localhost:9000' })).status, 200, 'a write');
    assert.equal((await withHost(port, 'evil.example:9000')).status, 403);
  } finally {
    forwarded.close();
  }
});

/** Can this machine open a TCP connection to `address`? (macOS has only 127.0.0.1 on loopback, for one.) */
function reachable(address: string, port: number) {
  return new Promise<boolean>((done) => {
    const s = connect({ host: address, port, timeout: 1000 }, () => { s.destroy(); done(true); });
    s.on('error', () => done(false));
    s.on('timeout', () => { s.destroy(); done(false); });
  });
}

test('end to end on a wildcard bind: the address a connection arrives on, as itself and IPv4-mapped', async (t) => {
  const json = { 'Content-Type': 'application/json' };
  const lan = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
  for (const bind of ['0.0.0.0', '::']) {
    const s = createServer(createHandler({ repo, engine, autopilot, runtime, publicDir: join(import.meta.dirname, '..', 'public'), host: bind }));
    const listening = await new Promise<boolean>((r) => { s.once('error', () => r(false)); s.listen(0, bind, () => r(true)); });
    if (!listening) { t.diagnostic(`cannot listen on ${bind} here`); continue; }
    const port = (s.address() as any).port as number;
    try {
      // 127.0.0.2 is loopback but not one of our names: only the arrival address lets it in.
      // On '::' an IPv4 connection arrives as ::ffff:127.0.0.2.
      for (const address of ['127.0.0.2', ...(lan ? [lan] : [])]) {
        if (!(await reachable(address, port))) { t.diagnostic(`${address} is not reachable here`); continue; }
        const host = `${address}:${port}`;
        assert.equal((await withHost(port, host, 'GET', '/', undefined, {}, address)).status, 200, `${bind}: the page at ${host}`);
        assert.equal((await withHost(port, host, 'POST', '/api/boards', '{"lang":"sv"}', { ...json, Origin: `http://${host}` }, address)).status, 200, `${bind}: a write at ${host}`);
        assert.equal((await withHost(port, `evil.example:${port}`, 'GET', '/api/boards', undefined, {}, address)).status, 403, `${bind}: a rebound name at ${address}`);
      }
      // Arriving at 127.0.0.1 while claiming 127.0.0.2: that is not where the connection came in.
      const r = await withHost(port, `127.0.0.2:${port}`);
      assert.equal(r.status, 403);
      assert.equal(r.code, 'bad_host');
      assert.equal((await withHost(port, `127.0.0.1:${port}`)).status, 200);
    } finally {
      s.close();
    }
  }
});


test('a Host without a port stands for http and https; one with a port for that port only', () => {
  assert.deepEqual(hostKeys('ideas.example.com'), ['ideas.example.com:80', 'ideas.example.com:443']);
  assert.deepEqual(hostKeys('Ideas.Example.com'), ['ideas.example.com:80', 'ideas.example.com:443']);
  assert.deepEqual(hostKeys('ideas.example.com:80'), ['ideas.example.com:80']);
  assert.deepEqual(hostKeys('ideas.example.com:443'), ['ideas.example.com:443']);
  assert.deepEqual(hostKeys('ideas.example.com:8300'), ['ideas.example.com:8300']);
  assert.deepEqual(hostKeys('[::1]'), ['[::1]:80', '[::1]:443']);
  assert.deepEqual(hostKeys('[::1]:8300'), ['[::1]:8300']);
  assert.deepEqual(hostKeys('evil/path'), []);
  assert.deepEqual(hostKeys(undefined), []);
});

test('behind a TLS proxy: name:443 matches the portless Host, and the https Origin passes', async () => {
  const start = async (allowedHostList: string) => {
    const s = createServer(createHandler({ repo, engine, autopilot, runtime, publicDir: join(import.meta.dirname, '..', 'public'), allowedHostList }));
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    return { s, port: (s.address() as any).port as number };
  };
  const json = { 'Content-Type': 'application/json' };
  const servers = [await start('ideas.example.com:443'), await start('ideas.example.com')];
  try {
    for (const { port } of servers) {
      const write = (host: string, origin: string) => withHost(port, host, 'POST', '/api/boards', '{"lang":"sv"}', { ...json, Origin: origin });
      // nginx with proxy_set_header Host $host: Host has no port, the page is https.
      assert.equal((await withHost(port, 'ideas.example.com', 'GET', '/')).status, 200, 'the page');
      assert.equal((await write('ideas.example.com', 'https://ideas.example.com')).status, 200, 'a write from the https page');
      assert.equal((await write('ideas.example.com:443', 'https://ideas.example.com')).status, 200, 'the port written out');
      // Another site is refused, and so is our name over another scheme and port pair.
      for (const origin of ['https://evil.example', 'https://ideas.example.com.evil.example', 'null', 'https://ideas.example.com:8443']) {
        const r = await write('ideas.example.com', origin);
        assert.equal(r.status, 403, origin);
        assert.equal(r.code, 'bad_origin');
      }
      // A proxy that rewrites Host to its upstream must pass Host on instead: the Origin is not that host.
      const upstream = await write(`127.0.0.1:${port}`, 'https://ideas.example.com');
      assert.equal(upstream.status, 403);
      assert.equal(upstream.code, 'bad_origin');
      // ...and the refusal says so, with what to change.
      assert.match(upstream.error!, /reverse proxy probably rewrote it/);
      assert.match(upstream.error!, /proxy_set_header Host \$host;/);
      assert.match(upstream.error!, /list ideas\.example\.com in ALLOWED_HOSTS/);
      // A plain cross-site refusal gets no proxy hint.
      assert.doesNotMatch((await write('ideas.example.com', 'https://evil.example')).error!, /proxy/);
    }
    // name:443 is that port only: a Host that names port 80 is not it.
    const [only443] = servers;
    assert.equal((await withHost(only443.port, 'ideas.example.com:80', 'GET', '/')).status, 403);
    assert.equal((await withHost(only443.port, 'ideas.example.com:8443', 'GET', '/')).status, 403);
  } finally {
    for (const { s } of servers) s.close();
  }
});

test('a bare ALLOWED_HOSTS name opens every port to Host, but the Origin must still be the Host', async () => {
  const s = createServer(createHandler({ repo, engine, autopilot, runtime, publicDir: join(import.meta.dirname, '..', 'public'), allowedHostList: 'localhost' }));
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  const port = (s.address() as any).port as number;
  try {
    const json = { 'Content-Type': 'application/json' };
    const write = (origin: string) => withHost(port, 'localhost:9000', 'POST', '/api/boards', '{"lang":"sv"}', { ...json, Origin: origin });
    assert.equal((await write('http://localhost:9000')).status, 200, 'the forwarded app itself');
    for (const origin of ['http://localhost:5173', 'http://localhost:3000', `http://localhost:${port}`, 'https://localhost', 'http://localhost']) {
      const r = await write(origin);
      assert.equal(r.status, 403, `${origin}: another local server is another app`);
      assert.equal(r.code, 'bad_origin');
    }
  } finally {
    s.close();
  }
});

test('on a wildcard bind the machine\'s own name and its .local name are ours, on our port, and no other name', () => {
  assert.deepEqual(machineNames('Studio-PC'), ['studio-pc', 'studio-pc.local']);
  assert.deepEqual(machineNames('studio.local'), ['studio.local', 'studio']);
  assert.deepEqual(machineNames('box.example.com.'), ['box.example.com', 'box', 'box.local']);
  for (const junk of ['', '  ', '192.168.1.20', '::1', '[::1]', '.local']) assert.deepEqual(machineNames(junk), [], junk);

  let name = 'Studio-PC';
  for (const bind of ['0.0.0.0', '::']) {
    const isOurs = hostGuard({ host: bind, hostname: () => name });
    const ok = (host: string, port = 8300) => isOurs(port, hostKey(host)!, '127.0.0.1');
    name = 'Studio-PC';
    for (const host of ['studio-pc:8300', 'studio-pc.local:8300', 'STUDIO-PC.LOCAL:8300']) {
      assert.equal(ok(host), true, `${bind}: ${host}`);
    }
    for (const host of [
      'studio-pc:8301', 'studio-pc.local:80', 'studio-pc.local', // another port, or none
      'other-pc.local:8300', 'evil.local:8300', 'local:8300', // another machine
      'studio-pc.evil.example:8300', 'studio-pc.local.evil.example:8300', 'evil-studio-pc.local:8300', 'xstudio-pc:8300', // look-alikes
    ]) {
      assert.equal(ok(host), false, `${bind}: ${host}`);
    }
    // A rename is seen at once, and the old name stops working.
    name = 'Atelier';
    assert.equal(ok('atelier.local:8300'), true);
    assert.equal(ok('studio-pc.local:8300'), false);
  }
  // A concrete HOST is reached at that address only: the machine's names are not added.
  for (const host of ['127.0.0.1', '192.168.1.20', 'localhost']) {
    const isOurs = hostGuard({ host, hostname: () => 'Studio-PC' });
    assert.equal(isOurs(8300, 'studio-pc.local:8300', '127.0.0.1'), false, host);
    assert.equal(isOurs(8300, 'studio-pc:8300', '127.0.0.1'), false, host);
  }
});

test('end to end on a wildcard bind: the page and a write at this machine\'s real host name', async () => {
  const json = { 'Content-Type': 'application/json' };
  const names = machineNames(hostname());
  assert.ok(names.length > 0, `os.hostname() gives a name: ${hostname()}`);
  const start = async (bind: string) => {
    const s = createServer(createHandler({ repo, engine, autopilot, runtime, publicDir: join(import.meta.dirname, '..', 'public'), host: bind }));
    await new Promise<void>((r) => s.listen(0, bind === '0.0.0.0' ? '127.0.0.1' : bind, r)); // reached over loopback; the guard only reads HOST
    return { s, port: (s.address() as any).port as number };
  };
  const wild = await start('0.0.0.0');
  const loop = await start('127.0.0.1');
  try {
    for (const name of names) {
      const host = `${name}:${wild.port}`;
      assert.equal((await withHost(wild.port, host, 'GET', '/')).status, 200, `the page at ${host}`);
      assert.equal((await withHost(wild.port, host, 'POST', '/api/boards', '{"lang":"sv"}', { ...json, Origin: `http://${host}` })).status, 200, `a write at ${host}`);
      const cross = await withHost(wild.port, host, 'POST', '/api/boards', '{"lang":"sv"}', { ...json, Origin: `http://${name}:5173` });
      assert.equal(cross.status, 403, `another app on ${name}`);
      assert.equal(cross.code, 'bad_origin');
      const elsewhere = await withHost(loop.port, `${name}:${loop.port}`, 'GET', '/');
      assert.equal(elsewhere.status, 403, `HOST=127.0.0.1 does not answer to ${name}`);
      assert.equal(elsewhere.code, 'bad_host');
    }
    for (const host of [`not-${names[0]}.local:${wild.port}`, `${names[0]}.evil.example:${wild.port}`, `evil.example:${wild.port}`]) {
      const r = await withHost(wild.port, host, 'GET', '/');
      assert.equal(r.status, 403, host);
      assert.equal(r.code, 'bad_host');
    }
  } finally {
    wild.s.close();
    loop.s.close();
  }
});
