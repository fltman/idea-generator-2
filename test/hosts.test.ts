// The IPv6 bracket helper, and that both guards use it rather than a copy of their own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { bracketed, ipv6Groups, isLoopbackHost, unbracketed, unmappedIPv4 } from '../server/hosts.ts';
import { allowedHosts, isWildcard, parseAllowedHosts } from '../server/app.ts';
import { assertPublicUrl } from '../server/extract.ts';

test('brackets go on bare IPv6 addresses only, and come off bracketed ones', () => {
  for (const [bare, wrapped] of [['::1', '[::1]'], ['fe80::1', '[fe80::1]'], ['::', '[::]'], ['::ffff:127.0.0.1', '[::ffff:127.0.0.1]']]) {
    assert.equal(bracketed(bare), wrapped);
    assert.equal(unbracketed(wrapped), bare);
    assert.equal(bracketed(wrapped), wrapped, 'already bracketed stays as is');
    assert.equal(unbracketed(bare), bare, 'already bare stays as is');
    assert.equal(unbracketed(bracketed(bare)), bare);
  }
  for (const other of ['localhost', '127.0.0.1', 'ideas.example.com', 'host:8300', 'not an ip:']) {
    assert.equal(bracketed(other), other, `${other} is not IPv6`);
    assert.equal(unbracketed(other), other);
  }
  assert.equal(bracketed('  ::1 '), '[::1]', 'trimmed');
  assert.equal(unbracketed('[::1'), '[::1', 'half a bracket is not a bracketed address');
});

test('both guards agree on bracketed and bare IPv6', async () => {
  // The Host guard: a bare HOST, a bare ALLOWED_HOSTS entry and the wildcard spelled both ways.
  assert.ok(allowedHosts(8300, '::1').has('[::1]:8300'));
  assert.ok(allowedHosts(8300, 'fd00::20').has('[fd00::20]:8300'));
  assert.ok(allowedHosts(8300, '[fd00::20]').has('[fd00::20]:8300'));
  assert.deepEqual([...parseAllowedHosts('fd00::20 [fd00::21]').names].sort(), ['[fd00::20]', '[fd00::21]']);
  assert.ok(isWildcard('::') && isWildcard('[::]'));
  // The private-address guard sees the address inside the brackets of a URL.
  const noDns = async () => { throw new Error('no DNS for IP literals'); };
  await assert.rejects(assertPublicUrl(new URL('http://[::1]/'), noDns), /private or local/);
  await assert.rejects(assertPublicUrl(new URL('http://[fd00::20]/'), noDns), /private or local/);
  await assertPublicUrl(new URL('http://[2606:2800:220:1:248:1893:25c8:1946]/'), noDns);
});

test('the two guards take their bracket handling from hosts.ts, not a copy of their own', () => {
  const copies = [/replace\(\/\^\\[/, /startsWith\(['"]\[['"]\)/, /`\[\$\{/];
  for (const file of ['app.ts', 'extract.ts']) {
    const src = readFileSync(join(import.meta.dirname, '..', 'server', file), 'utf8')
      .split('\n').filter((l) => !/console\.(error|log|warn)/.test(l)).join('\n'); // log prefixes like `[${req.method}` are not hosts
    assert.match(src, /from '\.\/hosts\.ts'/, `${file} imports hosts.ts`);
    for (const re of copies) assert.ok(!re.test(src), `${file} handles IPv6 brackets itself (${re}); use hosts.ts`);
  }
});

test('isLoopbackHost: this machine by name or address, in any spelling', () => {
  for (const h of ['localhost', 'LOCALHOST', 'localhost.', 'app.localhost', 'a.b.localhost', '127.0.0.1', '127.8.9.10', '127.255.255.255',
                   '::1', '[::1]', '0:0:0:0:0:0:0:1', '[0:0::1]', '::ffff:127.0.0.1', '[::ffff:7f00:1]', ' localhost '])
    assert.ok(isLoopbackHost(h), `${h} is this machine`);
  for (const h of ['localhost.example.com', 'notlocalhost', 'localhostx', '128.0.0.1', '126.255.255.255', '10.0.0.1', '0.0.0.0', '::', '[::2]',
                   '::ffff:10.0.0.1', 'ideas.example.com', '', 'fe80::1'])
    assert.ok(!isLoopbackHost(h), `${h} is not this machine`);
});

test('both guards take "this machine" from hosts.ts, not a definition of their own', () => {
  for (const file of ['app.ts', 'extract.ts']) {
    const src = readFileSync(join(import.meta.dirname, '..', 'server', file), 'utf8');
    assert.match(src, /isLoopbackHost/, `${file} uses isLoopbackHost`);
    assert.doesNotMatch(src, /endsWith\(['"]\.localhost['"]\)|startsWith\(['"]127\./, `${file} has its own loopback test; use isLoopbackHost`);
  }
});

test('unmappedIPv4: the IPv4 inside ::ffff:0:0/96, dotted or hex, and nothing else', () => {
  for (const [a, v4] of [
    ['::ffff:192.168.1.20', '192.168.1.20'], ['::FFFF:10.8.0.2', '10.8.0.2'], ['::ffff:a08:2', '10.8.0.2'],
    ['::ffff:7f00:1', '127.0.0.1'], ['0:0:0:0:0:ffff:c0a8:114', '192.168.1.20'], ['::ffff:8.8.8.8%3', '8.8.8.8'],
  ]) assert.equal(unmappedIPv4(a), v4, a);
  for (const a of ['192.168.1.20', '::1', '::', 'fe80::1', '::ffff:0:a08:2', '64:ff9b::a08:2', '1::ffff:a08:2', '2002:a08:2::1', 'not-an-ip', ''])
    assert.equal(unmappedIPv4(a), null, a);
  assert.deepEqual(ipv6Groups('::ffff:1.2.3.4'), [0, 0, 0, 0, 0, 0xffff, 0x102, 0x304]);
});

test('one IPv6 parser: extract.ts and app.ts take it from hosts.ts', () => {
  const src = (f: string) => readFileSync(join(import.meta.dirname, '..', 'server', f), 'utf8');
  assert.ok(!/function ipv6Groups/.test(src('extract.ts')), 'no copy in extract.ts');
  assert.ok(!/::ffff:\(/i.test(src('app.ts')), 'no IPv4-mapped regex in app.ts');
});
