import type { IncomingMessage } from 'node:http';

/** Protect every route that can indirectly spend the local user's credentials. */
export function localRequest(req: IncomingMessage, callback = false, publicNavigation = false) {
  const address = req.socket.remoteAddress;
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '')) return false;
  const port = req.socket.localPort;
  const host = req.headers.host;
  if (!host || ![`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(host)) return false;
  if (callback) return req.method === 'GET' && host === `127.0.0.1:${port}`;
  if (req.headers.origin && req.headers.origin !== `http://${host}`) return false;
  if (req.headers['sec-fetch-site'] === 'cross-site' && !(publicNavigation && req.method === 'GET' && req.headers['sec-fetch-mode'] === 'navigate' && req.headers['sec-fetch-dest'] === 'document')) return false;
  if (!['GET', 'HEAD', 'DELETE'].includes(req.method ?? '') && !req.headers['content-type']?.startsWith('application/json')) return false;
  return true;
}
