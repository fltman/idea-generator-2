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
