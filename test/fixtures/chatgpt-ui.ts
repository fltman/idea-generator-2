// Manual browser QA only. No credentials, network provider calls, or persistent DB.
// Run: node test/fixtures/chatgpt-ui.ts; open the printed 127.0.0.1 URL.
import { createServer } from 'node:http';
import { join } from 'node:path';
import { ChatGPT } from '../../server/chatgpt.ts';
import { createHandler } from '../../server/app.ts';
import { localRequest } from '../../server/local-request.ts';
import { openDb } from '../../server/db.ts';
import { createEngine } from '../../server/engine.ts';
import { createAutopilot } from '../../server/autopilot.ts';
import { DEFAULT_APP_SETTINGS } from '../../server/providers.ts';

const chatgpt = new ChatGPT({ load: () => ({ hostId: 'urn:uuid:3a178796-fd66-4f2a-b443-d596917a8490', accounts: [] }), save() {}, close() {} }, {
  verify: async () => ({ subject: 'mock-user', email: 'mock@example.test' }),
  fetcher: (async (url: string) => {
    if (url.endsWith('/token')) return Response.json({ token_type: 'Bearer', access_token: 'MOCK-access', refresh_token: 'MOCK-refresh', id_token: 'MOCK-id', expires_in: 3600, scope: 'openid resource.invoke chatgpt.tokens.use.direct' });
    if (url.endsWith('/models')) return Response.json({ models: [{ slug: 'mock-model', display_name: 'Mock model (offline QA)', visibility: 'list' }] });
    if (url.endsWith('openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', revocation_endpoint: 'https://auth.openai.com/mock-revoke' });
    if (url.endsWith('/mock-revoke')) return new Response('');
    throw new Error('No live network allowed in this fixture');
  }) as typeof fetch,
});
const repo = openDb(':memory:');
repo.createBoard({ title: 'OAuth UI QA', goal: 'Offline test board', lang: 'en' });
let settings = structuredClone(DEFAULT_APP_SETTINGS);
const runtime = { get: () => settings, set: (s: typeof settings) => { settings = s; }, received: () => true };
const engine = createEngine({ repo, chat: async () => ({ value: {}, costUsd: 0 }), settings: runtime.get });
const autopilot = createAutopilot({ repo, engine, settings: runtime.get });
const handler = createHandler({ repo, engine, autopilot, runtime, chatgpt, publicDir: join(import.meta.dirname, '../../public') });
const server = createServer((req, res) => {
  const url = new URL(req.url!, 'http://127.0.0.1');
  if (url.pathname === '/auth/chatgpt/authorize' && localRequest(req)) {
    try {
      const auth = chatgpt.authorize(url.searchParams.get('id') ?? '');
      const params = new URL(auth.url).searchParams;
      const state = encodeURIComponent(params.get('state')!);
      const client = encodeURIComponent(params.get('client_id') === 'dynamic_agent_client' ? 'oaiapp_mock' : params.get('client_id')!);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'Set-Cookie': `ideagen_oauth=${auth.cookie}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=600` });
      return res.end(`<h1>Offline ChatGPT mock — no account grant</h1><p>Leave this page open to test interruption.</p><a href="/auth/callback?state=${state}&code=MOCK-code&client_id=${client}">Complete mocked sign-in</a><br><a href="/auth/callback?state=${state}&error=access_denied">Decline mocked sign-in</a>`);
    } catch { res.writeHead(400); return res.end('Stale mock attempt'); }
  }
  // Optional latency for exercising the actual panel's Cancel-during-start control.
  if (url.pathname === '/api/chatgpt/start' && process.env.MOCK_START_DELAY_MS) {
    setTimeout(() => void handler(req, res), Number(process.env.MOCK_START_DELAY_MS));
  } else void handler(req, res);
});
server.listen(Number(process.env.PORT ?? 0), '127.0.0.1', () => console.log(`Offline UI fixture: http://127.0.0.1:${(server.address() as any).port}`));
