// Host names in one place for both guards: the Host and Origin guard in app.ts and
// the private-address guard in extract.ts. URLs and Host headers write an IPv6
// address in brackets ([::1]:8300); net, dns and BlockList take it bare (::1). And
// both need to know what "this machine" is. If the two guards disagreed on either,
// one could see an address the other missed.

import { BlockList, isIP } from 'node:net';

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

/**
 * This machine by name or address: localhost and any *.localhost name (RFC 6761: they
 * never leave the machine), 127.0.0.0/8 and ::1, in any spelling, bracketed or not,
 * with or without the trailing dot of a fully qualified name. IPv4-mapped forms
 * (::ffff:127.0.0.1, which URL writes as ::ffff:7f00:1) count too: BlockList checks
 * them against the IPv4 range.
 */
export function isLoopbackHost(host: string): boolean {
  const h = unbracketed(host).toLowerCase().replace(/\.$/, '');
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  const family = isIP(h);
  return family !== 0 && LOOPBACK.check(h, family === 4 ? 'ipv4' : 'ipv6');
}

/** "::1" becomes "[::1]", the form a URL or a Host header writes. Anything that is not a bare IPv6 address is returned as is. */
export function bracketed(host: string): string {
  const h = host.trim();
  return isIP(h) === 6 ? `[${h}]` : h;
}

/** "[::1]" becomes "::1", the form net, dns and BlockList take. Anything not wrapped in brackets is returned as is. */
export function unbracketed(host: string): string {
  const h = host.trim();
  return h.startsWith('[') && h.endsWith(']') ? h.slice(1, -1) : h;
}

/**
 * An IPv6 address as its eight 16-bit groups; accepts ::, a dotted IPv4 tail and a zone
 * id (dropped). The caller checks isIP(address) === 6 first. Shared by both guards, so
 * they read an IPv4 inside an IPv6 address the same way.
 */
export function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase().split('%')[0];
  const dotted = text.match(/^(.*:)(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) {
    const [a, b, c, d] = dotted[2].split('.').map(Number);
    text = `${dotted[1]}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.includes('::') ? text.split('::') : [text, undefined];
  const parse = (part: string | undefined) => (part ? part.split(':').map((g) => parseInt(g, 16)) : []);
  const left = parse(head);
  const right = parse(tail);
  return tail === undefined ? left : [...left, ...Array(8 - left.length - right.length).fill(0), ...right];
}

/**
 * The IPv4 address of an IPv4-mapped IPv6 address (::ffff:a.b.c.d, or the same written
 * in hex, ::ffff:7f00:1), or null. A dual-stack socket reports an IPv4 connection this way.
 */
export function unmappedIPv4(address: string): string | null {
  const bare = address.split('%')[0];
  if (isIP(bare) !== 6) return null;
  const g = ipv6Groups(bare);
  if (!g.slice(0, 5).every((x) => x === 0) || g[5] !== 0xffff) return null;
  return [g[6] >> 8, g[6] & 0xff, g[7] >> 8, g[7] & 0xff].join('.');
}
