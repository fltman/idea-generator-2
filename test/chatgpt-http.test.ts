import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { ChatGPT } from '../server/chatgpt.ts';
import { createHandler } from '../server/app.ts';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { createAutopilot } from '../server/autopilot.ts';
import { DEFAULT_APP_SETTINGS } from '../server/providers.ts';

test('HTTP OAuth flow binds cookie/state, scrubs callback URLs, rejects cross-origin and never exposes tokens', async () => {
  let saved: any = { hostId: 'urn:uuid:3a178796-fd66-4f2a-b443-d596917a8490', accounts: [] };
  let exchanges = 0;
  const chatgpt = new ChatGPT({ load: () => saved, save: d => { saved = structuredClone(d); }, close() {} }, {
    verify: async () => ({ subject: 'subject', email: 'test@example.test' }),
    fetcher: (async () => { exchanges++; return Response.json({ token_type: 'Bearer', access_token: 'PRIVATE-access', refresh_token: 'PRIVATE-refresh', id_token: 'PRIVATE-id', expires_in: 3600, scope: 'resource.invoke chatgpt.tokens.use.direct' }); }) as typeof fetch,
  });
  const repo = openDb(':memory:');
  let settings = structuredClone(DEFAULT_APP_SETTINGS);
  const runtime = { get: () => settings, set: s => { settings = s; }, received: () => true };
  const engine = createEngine({ repo, chat: async () => ({ value: {}, costUsd: 0 }), settings: runtime.get });
  const autopilot = createAutopilot({ repo, engine, settings: runtime.get });
  const server = createServer(createHandler({ repo, engine, autopilot, runtime, chatgpt, publicDir: join(import.meta.dirname, '..', 'public') }));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const post = (path: string, body = {}, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body), redirect: 'manual' });
  try {
    for (const path of ['/api/chatgpt/start', '/api/runtime-settings', '/api/boards']) assert.equal((await post(path, {}, { Origin: 'https://evil.example' })).status, 403);
    // Node fetch normalizes Host; use raw HTTP to exercise a rebinding request.
    const wrongHost = await new Promise<number>(resolve => {
      const req = httpRequest(base + '/api/chatgpt/status', { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode!); });
      req.end();
    });
    assert.equal(wrongHost, 403);
    const start = await post('/api/chatgpt/start'); assert.equal(start.status, 200); assert.equal(start.headers.get('cache-control'), 'no-store');
    const body = await start.json(); assert.match(body.url, /^\/auth\/chatgpt\/authorize\?id=/);
    const duplicateStart = await post('/api/chatgpt/start');
    assert.equal(duplicateStart.status, 400);
    assert.equal(duplicateStart.headers.get('cache-control'), 'no-store');
    const authorize = await fetch(base + body.url, { redirect: 'manual' });
    const cookieHeader = authorize.headers.get('set-cookie')!;
    assert.match(cookieHeader, /HttpOnly; SameSite=Lax/);
    const cookie = cookieHeader.split(';')[0];
    const url = new URL(authorize.headers.get('location')!);
    assert.equal(url.origin, 'https://auth.openai.com');
    const callback = `/auth/callback?${new URLSearchParams({ state: url.searchParams.get('state')!, code: 'PRIVATE-code', client_id: 'oaiapp_http' })}`;
    const withoutCookie = await fetch(base + callback, { redirect: 'manual' });
    assert.equal(withoutCookie.status, 303); assert.equal(exchanges, 0);
    const result = await fetch(base + callback, { redirect: 'manual', headers: { Cookie: cookie, 'Sec-Fetch-Site': 'cross-site' } });
    assert.equal(result.status, 303); assert.equal(result.headers.get('location'), '/auth/chatgpt/done');
    assert.equal(result.headers.get('referrer-policy'), 'no-referrer'); assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.match(result.headers.get('set-cookie')!, /Max-Age=0/); assert.equal(exchanges, 1);
    // Redirects retain Sec-Fetch-Site: cross-site after real OpenAI consent.
    // Raw HTTP preserves browser navigation metadata that Node fetch normalizes.
    const navigate = (path: string, headers = {}) => new Promise<{ status: number; body: string; headers: any }>(resolve => {
      const req = httpRequest(base + path, { headers: { 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Mode': 'navigate', 'Sec-Fetch-Dest': 'document', ...headers } }, res => {
        let body = ''; res.setEncoding('utf8'); res.on('data', chunk => { body += chunk; });
        res.on('end', () => resolve({ status: res.statusCode!, body, headers: res.headers }));
      }); req.end();
    });
    const done = await navigate(result.headers.get('location')!);
    assert.equal(done.status, 200); assert.match(done.body, /sign-in attempt finished/);
    assert.equal(done.headers['cache-control'], 'no-store'); assert.equal(done.headers['referrer-policy'], 'no-referrer');
    assert.ok(!done.body.includes('PRIVATE')); assert.ok(!done.body.includes('test@example.test'));
    assert.equal((await navigate('/auth/chatgpt/done', { 'Sec-Fetch-Dest': 'iframe' })).status, 403);
    assert.equal((await navigate('/auth/chatgpt/done', { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await navigate('/api/chatgpt/status')).status, 403);
    const status = await (await fetch(base + '/api/chatgpt/status')).text();
    assert.ok(!status.includes('PRIVATE')); assert.ok(saved.accounts[0].accessToken);
    await fetch(base + callback, { redirect: 'manual', headers: { Cookie: cookie } }); assert.equal(exchanges, 1);
    const again = await (await post('/api/chatgpt/start')).json();
    await post('/api/chatgpt/cancel', { attemptId: body.attemptId }); // Stale panel must not cancel a newer attempt.
    assert.equal((await (await fetch(base + '/api/chatgpt/status')).json()).pending, true);
    await post('/api/chatgpt/cancel', { attemptId: again.attemptId });
    assert.equal((await (await fetch(base + '/api/chatgpt/status')).json()).pending, false);
  } finally { chatgpt.close(); await new Promise<void>(r => server.close(() => r())); }
});
