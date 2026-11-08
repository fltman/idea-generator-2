// Seeds from a link: fetch the page and pull out readable text.
// Deliberately simple: prefer <article>, then <main>, then <body>; drop
// scripts, navigation and other chrome; keep paragraph breaks.

import { lookup as dnsLookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { BlockList, isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

const MAX_BYTES = 2_000_000;
const MAX_CHARS = 6000;
const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 12_000;

// Addresses that are never a web page we should read on a visitor's behalf: this
// machine, the LAN, link-local (cloud metadata lives at 169.254.169.254), and the
// unroutable blocks. A visitor types a URL in exhibition mode; without this the
// server would fetch http://127.0.0.1:8300/api/... or a router's admin page.
const PRIVATE = new BlockList();
for (const [net, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) PRIVATE.addSubnet(net, bits, 'ipv4');
// IPv6: ::/96 is unspecified, loopback and the old IPv4-compatible form (::10.0.0.1);
// 64:ff9b::/96 and the local-use 64:ff9b:1::/48 are NAT64, which a DNS64 network
// translates to the embedded IPv4 (64:ff9b::a9fe:a9fe reaches 169.254.169.254);
// ::ffff:0:0:0/96 is the SIIT IPv4-translated form; 2002::/16 is 6to4, also embedding
// IPv4; fec0::/10 is the retired site-local range; then unique-local, link-local, multicast.
// IPv4-mapped addresses (::ffff:a.b.c.d, which URL writes as ::ffff:7f00:1) need no
// rule of their own: BlockList checks them against the IPv4 subnets above.
for (const [net, bits] of [
  ['::', 96], ['::ffff:0:0:0', 96], ['64:ff9b::', 96], ['64:ff9b:1::', 48], ['2002::', 16],
  ['fc00::', 7], ['fec0::', 10], ['fe80::', 10], ['ff00::', 8],
] as const) PRIVATE.addSubnet(net, bits, 'ipv6');

/** True for loopback, LAN, link-local, multicast and unroutable addresses, and for anything that is not an IP. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  return family === 0 || PRIVATE.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

export type Lookup = (hostname: string) => Promise<string[]>;
const realLookup: Lookup = async (hostname) => (await dnsLookup(hostname, { all: true })).map((a) => a.address);

/** A link that leads to a private or local address, found by the check or by the connection itself. */
export class PrivateAddressError extends Error {}
const refusal = (name: string) => new PrivateAddressError(`Refusing to read a private or local address (${name})`);

/** Throws unless the URL is http(s) to a public host; every address the name resolves to must be public. */
export async function assertPublicUrl(url: URL, lookup: Lookup = realLookup) {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Only http(s) links can be read (${url.protocol})`);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const refuse = () => refusal(url.hostname);
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

type ConnectLookup = (
  hostname: string,
  options: { all?: boolean; family?: number } | number | undefined,
  callback: (err: Error | null, address: string | LookupAddress[], family?: number) => void,
) => void;

/**
 * The lookup the socket itself connects with (net.connect's `lookup` option).
 * assertPublicUrl resolves a name once, and a plain fetch would resolve it again to
 * connect: a name with a zero TTL can answer a public address to the check and
 * 127.0.0.1 or 169.254.169.254 to the connection (DNS rebinding). Refusing private
 * addresses here, in the answer the socket connects to, makes the address that was
 * checked the one that is used. IP literals never reach a lookup; assertPublicUrl
 * checks those, and they cannot change.
 */
export function guardedLookup(lookup: Lookup, isRefused: (address: string) => boolean = isPrivateAddress): ConnectLookup {
  return (hostname, options, callback) => {
    const opts = typeof options === 'object' && options ? options : { family: typeof options === 'number' ? options : 0 };
    const notFound = () => Object.assign(new Error(`Could not resolve ${hostname}`), { code: 'ENOTFOUND' });
    lookup(hostname).then(
      (addresses) => {
        if (!addresses.length) return callback(notFound(), '');
        if (addresses.some(isRefused)) return callback(refusal(hostname), '');
        const all = addresses.map((address) => ({ address, family: isIP(address) }));
        const wanted = opts.family ? all.filter((a) => a.family === opts.family) : all;
        if (!wanted.length) return callback(notFound(), '');
        if (opts.all) callback(null, wanted);
        else callback(null, wanted[0].address, wanted[0].family);
      },
      (e) => callback(e instanceof Error ? e : notFound(), ''),
    );
  };
}

/** An undici dispatcher whose every connection goes through guardedLookup. */
export function createDispatcher(lookup: Lookup, isRefused?: (address: string) => boolean) {
  return new Agent({ connect: { lookup: guardedLookup(lookup, isRefused) } });
}

/** The dispatcher for real DNS, shared so connections are pooled across reads. */
let sharedDispatcher: Agent | undefined;

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

const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'sv,en;q=0.8',
};

/** Waits for `p`, or rejects as soon as `signal` aborts. A DNS lookup takes no signal of its own. */
function untilAborted<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(signal.reason);
    signal.addEventListener('abort', stop, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener('abort', stop));
  });
}

/** Drops a body we will not read, so its connection goes back to the pool now rather than at garbage collection. */
async function discard(res: Response, signal: AbortSignal) {
  if (res.body && !res.bodyUsed) await untilAborted(res.body.cancel().catch(() => {}), signal);
}

/** Reads at most `max` bytes, then cancels the stream so the rest is never downloaded. */
async function readCapped(body: ReadableStream<Uint8Array> | null, max: number, signal: AbortSignal): Promise<Uint8Array> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < max) {
      const { done, value } = await untilAborted(reader.read(), signal);
      if (done) break;
      const room = max - size;
      const part = value.byteLength > room ? value.subarray(0, room) : value;
      chunks.push(part);
      size += part.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {}); // past the cap, or out of time: stop the download either way
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export async function fetchPage(
  url: string, deps: { fetch?: typeof fetch; lookup?: Lookup; timeoutMs?: number } = {},
): Promise<{ title: string; text: string }> {
  const ms = deps.timeoutMs ?? TIMEOUT_MS;
  const lookup = deps.lookup ?? realLookup;
  // undici's own fetch, not the global one: a dispatcher from the undici package
  // is only guaranteed to work with the fetch from the same package.
  const doFetch = deps.fetch ?? (undiciFetch as unknown as typeof fetch);
  // The connection resolves names through the same lookup as the check, and refuses private answers.
  const own = deps.lookup ? createDispatcher(lookup) : undefined;
  const dispatcher = own ?? (sharedDispatcher ??= createDispatcher(realLookup));
  // One deadline for the whole read: every DNS lookup, every redirect hop and the body.
  // A plain timer rather than AbortSignal.timeout(), whose timer is unref'd: it is
  // cleared as soon as the read ends, and it keeps a waiting process alive meanwhile.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(new DOMException('Deadline passed', 'TimeoutError')), ms);
  const { signal } = deadline;
  try {
    return await readPage(new URL(url), doFetch, lookup, dispatcher, signal);
  } catch (e) {
    // fetch reports a refused connection as "fetch failed" with the reason as its cause.
    for (let c: unknown = e; c instanceof Error; c = c.cause) if (c instanceof PrivateAddressError) throw c;
    if (signal.aborted) throw new Error(`No answer within ${ms / 1000} s`);
    throw e;
  } finally {
    clearTimeout(timer);
    own?.destroy().catch(() => {});
  }
}

async function readPage(start: URL, doFetch: typeof fetch, lookup: Lookup, dispatcher: Agent, signal: AbortSignal) {
  const timedLookup: Lookup = (host) => untilAborted(lookup(host), signal);
  let current = start;
  // Redirects are followed by hand so that every hop gets the same host check.
  for (let hop = 0; ; hop++) {
    await assertPublicUrl(current, timedLookup);
    const init = { redirect: 'manual', signal, headers: HEADERS, dispatcher } as RequestInit;
    const res = await untilAborted(doFetch(current, init), signal);
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      await discard(res, signal);
      if (hop >= MAX_REDIRECTS) throw new Error('Too many redirects');
      current = new URL(location, current);
      continue;
    }
    if (!res.ok) {
      await discard(res, signal);
      throw new Error(`HTTP ${res.status}`);
    }
    const type = res.headers.get('content-type') ?? '';
    if (!/html|text\/plain/i.test(type)) {
      await discard(res, signal);
      throw new Error(`Not a web page (${type || 'unknown type'})`);
    }
    const html = new TextDecoder('utf-8').decode(await readCapped(res.body, MAX_BYTES, signal));
    return /text\/plain/i.test(type) ? { title: '', text: html.slice(0, MAX_CHARS) } : htmlToText(html);
  }
}
