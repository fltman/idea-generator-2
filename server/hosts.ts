// IPv6 brackets, in one place for both guards: the Host and Origin guard in
// app.ts and the private-address guard in extract.ts. URLs and Host headers write
// an IPv6 address in brackets ([::1]:8300); net, dns and BlockList take it bare (::1).
// If the two guards disagreed on that, one could see an address the other missed.

import { isIP } from 'node:net';

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
