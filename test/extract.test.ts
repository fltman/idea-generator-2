import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asUrl, decodeEntities, fetchPage, htmlToText, isPrivateAddress } from '../server/extract.ts';

test('recognises a lone link, with or without scheme', () => {
  assert.equal(asUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(asUrl('  www.example.se/artikel '), 'https://www.example.se/artikel');
  assert.equal(asUrl('elcyklar i glesbygd'), null);
  assert.equal(asUrl('läs https://example.com'), null, 'text with a link in it is text');
  assert.equal(asUrl('javascript:alert(1)'), null);
  assert.equal(asUrl('ftp://example.com'), null);
});

test('decodes named and numeric entities, including Swedish letters', () => {
  assert.equal(decodeEntities('R&auml;ksm&ouml;rg&aring;s &amp; &#229;&#xE4; &hellip;'), 'Räksmörgås & åä …');
  assert.equal(decodeEntities('&bogus; &#0;'), '&bogus; &#0;');
});

test('extracts the article and drops scripts, navigation and footers', () => {
  const html = `<!doctype html><html><head>
    <title>Fallback title</title>
    <meta property="og:title" content="Cykelbibliotek i Växjö">
    <style>.x{color:red}</style><script>var secret = 1;</script></head>
    <body><nav>Meny Hem Om</nav>
    <article><h1>Cykelbibliotek</h1><p>Kommunen l&aring;nar ut <b>lastcyklar</b>.</p>
    <script>tracking()</script><p>Andra stycket.<br>Ny rad.</p></article>
    <footer>© 2026</footer></body></html>`;
  const { title, text } = htmlToText(html);
  assert.equal(title, 'Cykelbibliotek i Växjö');
  assert.match(text, /^Cykelbibliotek\n\nKommunen lånar ut lastcyklar \./);
  assert.match(text, /Andra stycket\.\nNy rad\./);
  for (const junk of ['secret', 'tracking', 'Meny', '©', 'color:red']) assert.ok(!text.includes(junk), junk);
});

test('falls back to <title> and <body> when there is no article', () => {
  const { title, text } = htmlToText('<title>T &amp; T</title><body><div>Hej</div><div>då</div></body>');
  assert.equal(title, 'T & T');
  assert.equal(text, 'Hej\n\ndå');
});

test('caps very long pages', () => {
  const { text } = htmlToText(`<body><p>${'ord '.repeat(5000)}</p></body>`);
  assert.ok(text.length <= 6000 + 4);
  assert.ok(text.endsWith('[…]'));
});

test('links to this machine, the LAN and link-local are refused, also after a redirect', async () => {
  for (const a of ['127.0.0.1', '127.8.8.8', '10.0.0.5', '172.31.9.9', '192.168.1.1', '169.254.169.254', '0.0.0.0', '100.64.0.1', '::1', '::', 'fe80::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', 'not-an-ip',
                   '64:ff9b::a9fe:a9fe', '64:ff9b::808:808', '::a9fe:a9fe', '::10.0.0.1', '::127.0.0.1', 'fec0::1', 'feff::1', '2002:c0a8:101::1', '2002:808:808::1'])
    assert.ok(isPrivateAddress(a), `${a} is private`);
  for (const a of ['93.184.216.34', '8.8.8.8', '172.32.0.1', '2606:2800:220:1:248:1893:25c8:1946', '::ffff:8.8.8.8',
                   '2001:4860:4860::8888', '64:ff9c::1', '2003::1', '::1:0:0:1'])
    assert.ok(!isPrivateAddress(a), `${a} is public`);

  // Names resolve through an injected lookup: no network in the tests.
  const dns: Record<string, string[]> = {
    'example.com': ['93.184.216.34'], 'www.example.com': ['93.184.216.34', '2606:2800:220:1:248:1893:25c8:1946'],
    'rebind.example': ['93.184.216.34', '10.0.0.5'], 'intranet.example': ['192.168.0.10'],
  };
  const lookup = async (h: string) => { if (!dns[h]) throw new Error('ENOTFOUND'); return dns[h]; };
  const fetched: string[] = [];
  const page = (title: string) => new Response(`<title>${title}</title><body><p>Text</p></body>`, { status: 200, headers: { 'content-type': 'text/html' } });
  const fake = (async (u: URL | string | Request) => {
    const url = String(u);
    fetched.push(url);
    if (url === 'https://example.com/go') return new Response(null, { status: 302, headers: { location: 'http://127.0.0.1:8300/api/boards' } });
    if (url === 'https://example.com/hop') return new Response(null, { status: 301, headers: { location: '/landed' } });
    if (url === 'https://example.com/loop') return new Response(null, { status: 302, headers: { location: '/loop' } });
    if (url === 'https://example.com/landed') return page('Landed');
    return page('Direct');
  }) as typeof fetch;
  const read = (u: string) => fetchPage(u, { fetch: fake, lookup });
  const refused = /private or local/;

  for (const u of ['http://127.0.0.1:8300/api/boards', 'http://localhost/', 'http://a.localhost/', 'http://[::1]/', 'http://169.254.169.254/latest/meta-data',
                   'http://10.1.2.3/', 'http://192.168.1.1/admin', 'http://[fe80::1]/', 'http://intranet.example/', 'http://rebind.example/',
                   'http://[64:ff9b::a9fe:a9fe]/latest/meta-data', 'http://[::a9fe:a9fe]/', 'http://[fec0::1]/', 'http://[2002:a9fe:a9fe::1]/'])
    await assert.rejects(read(u), refused, u);
  await assert.rejects(read('ftp://example.com/'), /http/);
  await assert.rejects(read('https://nowhere.example/'), /resolve/);
  assert.deepEqual(fetched, [], 'nothing was fetched');

  await assert.rejects(read('https://example.com/go'), refused, 'a redirect to this machine is refused');
  assert.deepEqual(fetched, ['https://example.com/go'], 'the redirect target was never fetched');
  fetched.length = 0;
  assert.equal((await read('https://example.com/hop')).title, 'Landed', 'a public redirect is followed');
  assert.deepEqual(fetched, ['https://example.com/hop', 'https://example.com/landed']);
  assert.equal((await read('https://www.example.com/')).title, 'Direct');
  await assert.rejects(read('https://example.com/loop'), /redirects/);
});
