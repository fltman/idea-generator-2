// Seeds from a link: fetch the page and pull out readable text.
// Deliberately simple: prefer <article>, then <main>, then <body>; drop
// scripts, navigation and other chrome; keep paragraph breaks.

import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const MAX_BYTES = 2_000_000;
const MAX_CHARS = 6000;
const MAX_REDIRECTS = 5;

// Addresses that are never a web page we should read on a visitor's behalf: this
// machine, the LAN, link-local (cloud metadata lives at 169.254.169.254), and the
// unroutable blocks. A visitor types a URL in exhibition mode; without this the
// server would fetch http://127.0.0.1:8300/api/... or a router's admin page.
const PRIVATE = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) PRIVATE.addSubnet(net, bits, 'ipv4');
for (const [net, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]] as const) PRIVATE.addSubnet(net, bits, 'ipv6');

/** True for loopback, LAN, link-local, multicast and unroutable addresses, and for anything that is not an IP. */
export function isPrivateAddress(address: string): boolean {
  const mapped = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (mapped) return isPrivateAddress(mapped[1]);
  const family = isIP(address);
  return family === 0 || PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export type Lookup = (hostname: string) => Promise<string[]>;
const realLookup: Lookup = async (hostname) => (await dnsLookup(hostname, { all: true })).map((a) => a.address);

/** Throws unless the URL is http(s) to a public host; every address the name resolves to must be public. */
export async function assertPublicUrl(url: URL, lookup: Lookup = realLookup) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Only http(s) links can be read (${url.protocol})`);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const refuse = () => new Error(`Refusing to read a private or local address (${url.hostname})`);
  if (host === 'localhost' || host.endsWith('.localhost')) throw refuse();
  if (isIP(host)) {
    if (isPrivateAddress(host)) throw refuse();
    return;
  }
  let addresses: string[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new Error(`Could not resolve ${url.hostname}`);
  }
  if (!addresses.length || addresses.some(isPrivateAddress)) throw refuse();
}

/** A single URL (optionally without scheme), or null if the text is not one. */
export function asUrl(text: string): string | null {
  const t = text.trim();
  if (/\s/.test(t)) return null;
  const candidate = /^https?:\/\//i.test(t) ? t : /^www\.[^\s.]+\.\S+$/i.test(t) ? `https://${t}` : null;
  if (!candidate) return null;
  try {
    const u = new URL(candidate);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—',
  hellip: '…', laquo: '«', raquo: '»', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  aring: 'å', auml: 'ä', ouml: 'ö', Aring: 'Å', Auml: 'Ä', Ouml: 'Ö', eacute: 'é',
};

export function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function htmlToText(html: string): { title: string; text: string } {
  const titleMatch =
    html.match(/<meta[^>]+property=["']og:title["'][^>]*content=["']([^"']+)["']/i) ||
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : '';

  let body = html.replace(/<!--[\s\S]*?-->/g, '');
  for (const tag of ['script', 'style', 'noscript', 'svg', 'nav', 'header', 'footer', 'aside', 'form', 'template', 'iframe']) {
    body = body.replace(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, 'gi'), ' ');
  }
  const pick = (tag: string) => body.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'))?.[1];
  const main = pick('article') ?? pick('main') ?? pick('body') ?? body;

  const text = decodeEntities(
    main
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|h[1-6]|li|blockquote|section|tr)>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .split('\n')
    .map((l) => l.replace(/[ \t ]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { title, text: text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS)}\n[…]` : text };
}

export async function fetchPage(
  url: string, deps: { fetch?: typeof fetch; lookup?: Lookup } = {},
): Promise<{ title: string; text: string }> {
  const doFetch = deps.fetch ?? fetch;
  let current = new URL(url);
  let res: Response;
  // Redirects are followed by hand so that every hop gets the same host check.
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(current, deps.lookup);
    res = await doFetch(current, {
      redirect: 'manual',
      signal: AbortSignal.timeout(12_000),
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'sv,en;q=0.8',
      },
    });
    const location = res.headers.get('location');
    if (!(res.status >= 300 && res.status < 400 && location)) break;
    if (hop >= MAX_REDIRECTS) throw new Error('Too many redirects');
    current = new URL(location, current);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') ?? '';
  if (!/html|text\/plain/i.test(type)) throw new Error(`Not a web page (${type || 'unknown type'})`);
  const buf = await res.arrayBuffer();
  const html = new TextDecoder('utf-8').decode(buf.byteLength > MAX_BYTES ? buf.slice(0, MAX_BYTES) : buf);
  return /text\/plain/i.test(type) ? { title: '', text: html.slice(0, MAX_CHARS) } : htmlToText(html);
}
