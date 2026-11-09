import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { ChatGPT, identityVerifier } from '../server/chatgpt.ts';
import { makeChat, mergeAppSettings, DEFAULT_APP_SETTINGS } from '../server/providers.ts';
import type { Credentials, Account } from '../server/chatgpt-store.ts';

const now = Date.now();
const savedAccount = (id = 'one'): Account => ({ id, clientId: `oaiapp_${id}`, subject: id, email: 'same@example.test',
  accessToken: `access-${id}`, refreshToken: `refresh-${id}`, idToken: `id-${id}`, expiresAt: now + 3600_000,
  refreshExpiresAt: now + 86400_000, scopes: ['resource.invoke', 'chatgpt.tokens.use.direct'] });
const reply = (data: any, status = 200) => Response.json(data, { status });
const tokenReply = (extra = {}) => reply({ token_type: 'Bearer', access_token: 'access-new', refresh_token: 'refresh-new', id_token: 'id-new', expires_in: 3600,
  scope: 'openid resource.invoke chatgpt.tokens.use.direct', ...extra });
function fixture(accounts: Account[] = []) {
  let persisted: Credentials = { hostId: 'urn:uuid:3a178796-fd66-4f2a-b443-d596917a8490', accounts, active: accounts[0]?.id };
  const seen: { url: string; options: RequestInit }[] = [];
  let handler = async (_url: string, _options: RequestInit) => tokenReply();
  let clock = now;
  let identity = { subject: 'one', email: 'same@example.test' };
  const app = new ChatGPT({ load: () => structuredClone(persisted), save: d => { persisted = structuredClone(d); }, close() {} }, {
    now: () => clock,
    fetcher: (async (url: any, options: RequestInit) => { seen.push({ url: String(url), options }); assert.equal(options.redirect, 'error'); return handler(String(url), options); }) as typeof fetch,
    verify: async () => identity,
  });
  return { app, seen, persisted: () => persisted, advance: (ms: number) => { clock += ms; }, identity: (id: string) => { identity = { ...identity, subject: id }; },
    respond: (fn: typeof handler) => { handler = fn; } };
}
function begin(app: ChatGPT, accountId?: string, consent = false) {
  const start = app.begin('http://127.0.0.1:8300', accountId, consent);
  const auth = app.authorize(new URL(start.url, 'http://local').searchParams.get('id')!);
  return { params: new URL(auth.url).searchParams, cookie: auth.cookie };
}
function callback(params: URLSearchParams, clientId = 'oaiapp_one') {
  return new URLSearchParams({ state: params.get('state')!, code: 'one-use-code', client_id: clientId });
}
const request = { model: 'chatgpt:test-model', system: 'instructions', user: 'idea', schemaName: 'idea',
  schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false }, temperature: 0.9, maxTokens: 20 };
function stream(events: any[], split = false) {
  const bytes = new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream({ start(c) { if (split) for (const byte of bytes) c.enqueue(new Uint8Array([byte])); else c.enqueue(bytes); c.close(); } }), { headers: { 'Content-Type': 'text/event-stream' } });
}
const delta = { type: 'response.output_text.delta', delta: '{"title":"idé"}' };
const completed = { type: 'response.completed', response: { status: 'completed' } };

test('dynamic registration: host persistence, random state/nonce, PKCE, issued client exchange and secret-free status', async () => {
  const f = fixture(); const auth = begin(f.app);
  assert.equal(auth.params.get('client_id'), 'dynamic_agent_client');
  assert.equal(auth.params.get('agent_name_hint'), 'Idea Generator 2');
  assert.equal(auth.params.get('ext_agent_host_id'), f.persisted().hostId);
  assert.equal(auth.params.get('code_challenge_method'), 'S256');
  assert.match(auth.params.get('scope')!, /offline_access.*chatgpt.tokens.use.direct/);
  await f.app.callback(callback(auth.params), auth.cookie);
  const body = f.seen[0].options.body as URLSearchParams;
  assert.equal(body.get('client_id'), 'oaiapp_one');
  assert.equal(body.get('redirect_uri'), auth.params.get('redirect_uri'));
  assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'), auth.params.get('code_challenge'));
  assert.equal(body.has('client_secret'), false);
  const status = JSON.stringify(f.app.status());
  for (const secret of ['access-new', 'refresh-new', 'id-new', 'one-use-code', body.get('code_verifier')!]) assert.ok(!status.includes(secret));
  assert.equal(f.persisted().accounts[0].clientId, 'oaiapp_one');
  await assert.rejects(f.app.callback(callback(auth.params), auth.cookie), { code: 'invalid_state' });
});

test('wrong state/cookie, duplicates, cancellation, timeout and repeated clicks never exchange tokens', async () => {
  const f = fixture(); const a = begin(f.app);
  assert.throws(() => begin(f.app), { code: 'sign_in_pending' });
  await assert.rejects(f.app.callback(new URLSearchParams({ state: 'wrong' }), a.cookie), { code: 'invalid_state' });
  await assert.rejects(f.app.callback(callback(a.params), 'other-browser'), { code: 'invalid_state' });
  const duplicate = callback(a.params); duplicate.append('state', a.params.get('state')!);
  await assert.rejects(f.app.callback(duplicate, a.cookie), { code: 'invalid_state' });
  f.app.cancel();
  await assert.rejects(f.app.callback(callback(a.params), a.cookie), { code: 'invalid_state' });
  const b = begin(f.app); assert.notEqual(a.params.get('state'), b.params.get('state'));
  f.advance(600_001);
  await assert.rejects(f.app.callback(callback(b.params), b.cookie), { code: 'invalid_state' });
  assert.equal(f.seen.length, 0);
});

test('declined consent ends attempt and keeps the active account', async () => {
  const f = fixture([savedAccount()]); const a = begin(f.app);
  await assert.rejects(f.app.callback(new URLSearchParams({ state: a.params.get('state')!, error: 'access_denied' }), a.cookie), { code: 'consent_declined' });
  assert.equal(f.app.status().active, 'one'); assert.equal(f.app.status().pending, false); assert.equal(f.seen.length, 0);
});

test('new registration requires issued client, reauthorization rejects substitutions and different identities', async () => {
  for (const client of ['', 'dynamic_agent_client']) {
    const f = fixture(); const a = begin(f.app);
    await assert.rejects(f.app.callback(callback(a.params, client), a.cookie), { code: 'invalid_client' });
    assert.equal(f.seen.length, 0);
  }
  const f = fixture([savedAccount()]); let a = begin(f.app, 'one');
  assert.equal(a.params.get('agent_name_hint'), null); assert.equal(a.params.get('client_id'), 'oaiapp_one');
  assert.equal(a.params.has('id_token_hint'), false);
  await assert.rejects(f.app.callback(callback(a.params, 'oaiapp_other'), a.cookie), { code: 'invalid_client' });
  a = begin(f.app, 'one'); f.identity('wrong');
  await assert.rejects(f.app.callback(callback(a.params), a.cookie), { code: 'account_mismatch' });
  assert.equal(f.persisted().accounts[0].accessToken, 'access-one');
});

test('invalid_grant on initial exchange retains issued client for next authorization', async () => {
  const f = fixture(); const a = begin(f.app);
  f.respond(async () => reply({ error: 'invalid_grant' }, 400));
  await assert.rejects(f.app.callback(callback(a.params), a.cookie), { code: 'invalid_grant' });
  const b = begin(f.app); assert.equal(b.params.get('client_id'), 'oaiapp_one'); assert.equal(b.params.has('agent_name_hint'), false);
});

test('cancel during exchange prevents late credentials from becoming active', async () => {
  const f = fixture(); const a = begin(f.app);
  let resolve!: (r: Response) => void;
  f.respond(() => new Promise(r => { resolve = r; }));
  const pending = f.app.callback(callback(a.params), a.cookie);
  f.app.cancel(); resolve(tokenReply());
  await assert.rejects(pending, { code: 'stale_sign_in' });
  assert.equal(f.persisted().accounts.length, 0);
});

test('identity-only sign-in is retained, but cannot infer; explicit consent uses saved client', async () => {
  const f = fixture(); const a = begin(f.app);
  f.respond(async () => tokenReply({ scope: 'openid email' }));
  await f.app.callback(callback(a.params), a.cookie);
  await assert.rejects(f.app.chat(request), { code: 'plan_disabled' });
  assert.equal(f.app.status().accounts[0].planEnabled, false);
  const consent = begin(f.app, f.app.status().accounts[0].id, true);
  assert.equal(consent.params.get('prompt'), 'consent'); assert.equal(consent.params.get('client_id'), 'oaiapp_one');
});

test('separate registrations with identical emails, account switch, signout and returning client reuse', async () => {
  const f = fixture([savedAccount(), savedAccount('two')]);
  f.app.select('two'); assert.equal(f.app.status().active, 'two');
  f.respond(async url => url.includes('openid-configuration') ? reply({ issuer: 'https://auth.openai.com', revocation_endpoint: 'https://auth.openai.com/revoke' }) : new Response('', { status: 200 }));
  assert.deepEqual(await f.app.signOut('two'), { revoked: true });
  assert.equal(f.persisted().accounts[0].accessToken, 'access-one');
  assert.equal(f.persisted().accounts[1].accessToken, undefined);
  assert.equal(f.persisted().accounts[1].idToken, undefined);
  assert.equal(begin(f.app, 'two').params.get('client_id'), 'oaiapp_two');
});

test('failed revocation clears local tokens and warns; untrusted revocation origins never receive tokens', async () => {
  const f = fixture([savedAccount()]);
  f.respond(async () => reply({ issuer: 'https://auth.openai.com', revocation_endpoint: 'https://evil.example/revoke' }));
  assert.deepEqual(await f.app.signOut('one'), { revoked: false });
  assert.equal(f.seen.length, 1); assert.equal(f.persisted().accounts[0].refreshToken, undefined);
  assert.match(f.app.status().message, /not confirmed/);
});

test('refresh is single-flight and atomically replaces rotating tokens before inference', async () => {
  const f = fixture([{ ...savedAccount(), expiresAt: now }]);
  let resolve!: (r: Response) => void;
  f.respond(async url => url.endsWith('/token') ? new Promise(r => { resolve = r; }) : reply({ models: [] }));
  const calls = [f.app.models(), f.app.models()];
  assert.equal(f.seen.length, 1);
  const body = f.seen[0].options.body as URLSearchParams;
  assert.equal(body.get('refresh_token'), 'refresh-one'); assert.equal(body.get('client_id'), 'oaiapp_one'); assert.equal(body.has('scope'), false);
  resolve(tokenReply({ id_token: undefined })); await Promise.all(calls);
  assert.equal(f.persisted().accounts[0].refreshToken, 'refresh-new');
  assert.equal((f.seen[1].options.headers as any).Authorization, 'Bearer access-new');
});

test('terminal refresh errors clear credentials; temporary errors retain them', async () => {
  for (const error of ['invalid_grant', 'refresh_token_reused', 'temporarily_unavailable']) {
    const f = fixture([{ ...savedAccount(), expiresAt: now }]);
    f.respond(async () => reply({ error, error_description: 'secret-access-token' }, 400));
    await assert.rejects(f.app.models(), e => !String(e).includes('secret-access-token'));
    assert.equal(!!f.persisted().accounts[0].refreshToken, error === 'temporarily_unavailable');
  }
});

test('catalog uses models/slug/display_name/visibility and preserves server order', async () => {
  const f = fixture([savedAccount()]);
  f.respond(async () => reply({ models: [{ slug: 'z', display_name: 'Zed', visibility: 'list' }, { slug: 'hidden', display_name: 'Hidden' }, { slug: 'a', display_name: 'Aye', visibility: 'list' }] }));
  assert.deepEqual(await f.app.models(), [{ slug: 'z', displayName: 'Zed' }, { slug: 'a', displayName: 'Aye' }]);
  assert.equal(f.seen[0].url, 'https://api.openai.com/v1/models');
});

test('Responses adapter ignores browser keys/URLs and omits unsupported preview fields', async () => {
  const f = fixture([savedAccount()]); f.respond(async () => stream([delta, completed], true));
  const settings = mergeAppSettings({ keys: { chatgpt: 'do-not-use' }, baseUrls: { chatgpt: 'https://evil.example' } });
  assert.equal(settings.keys.chatgpt, undefined); assert.equal(settings.baseUrls.chatgpt, undefined);
  const result = await makeChat(() => settings, f.app)(request);
  assert.deepEqual(result, { value: { title: 'idé' }, costUsd: 0 });
  assert.equal(f.seen[0].url, 'https://api.openai.com/v1/responses');
  const body = JSON.parse(String(f.seen[0].options.body));
  assert.equal(body.store, false); assert.equal(body.stream, true); assert.ok(Array.isArray(body.input)); assert.equal(body.instructions, 'instructions');
  assert.equal(body.model, 'test-model'); assert.equal(body.text.format.type, 'json_schema');
  for (const key of ['temperature', 'max_tokens', 'max_output_tokens', 'previous_response_id', 'messages']) assert.equal(key in body, false);
  await assert.rejects(makeChat(() => DEFAULT_APP_SETTINGS)(request), { code: 'chatgpt_disabled' });
});

test('partial JSON never succeeds without a completed event; late failures pause further usage', async () => {
  for (const tail of [[], [{ type: 'response.incomplete' }], [{ type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }], [{ type: 'error', code: 'subscription_sharing_usage_unavailable', message: 'private detail', param: null }], [{ type: 'error', code: 'subscription_sharing_usage_limit_exceeded', message: 'private detail', param: null }]]) {
    const f = fixture([savedAccount()]); f.respond(async () => stream([delta, ...tail]));
    await assert.rejects(f.app.chat(request));
    if (tail[0]?.type === 'response.failed' || tail[0]?.code === 'subscription_sharing_usage_limit_exceeded') {
      await assert.rejects(f.app.chat(request), { code: 'subscription_sharing_usage_limit_exceeded' }); assert.equal(f.seen.length, 1);
      f.app.resume(); f.respond(async () => stream([delta, completed])); assert.equal((await f.app.chat(request)).value.title, 'idé');
    }
  }
});

test('JWT verification rejects signature, issuer, audience, expiry and nonce mismatches', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const key = await exportJWK(publicKey); key.kid = 'test';
  const verify = identityVerifier(createLocalJWKSet({ keys: [key] }));
  const claims = { sub: 'one', iss: 'https://auth.openai.com', aud: 'oaiapp_one', nonce: 'nonce', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 600 };
  const sign = (patch = {}, signer = privateKey) => new SignJWT({ ...claims, ...patch }).setProtectedHeader({ alg: 'RS256', kid: 'test' }).sign(signer);
  assert.equal((await verify(await sign(), 'oaiapp_one', 'nonce')).subject, 'one');
  for (const patch of [{ iss: 'https://evil.example' }, { aud: 'oaiapp_other' }, { exp: 1 }, { nonce: 'wrong' }, { nonce: undefined }, { sub: '' }, { sub: 123 }]) await assert.rejects(verify(await sign(patch), 'oaiapp_one', 'nonce'), { code: 'invalid_identity' });
  await assert.rejects(verify(await sign({}, other.privateKey), 'oaiapp_one', 'nonce'), { code: 'invalid_identity' });
});

test('invalid response formats cancel unused bodies and expose only safe reason categories', async () => {
  for (const contentType of ['application/json; private=DO-NOT-LOG', 'text/html', 'application/text/event-stream', 'text/event-stream-invalid', '']) {
    let cancelled = false;
    const f = fixture([savedAccount()]);
    f.respond(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('DO-NOT-LOG')); },
      cancel() { cancelled = true; },
    }), { headers: { 'Content-Type': contentType } }));
    await assert.rejects(f.app.chat(request), (e: any) => e.code === 'invalid_stream' &&
      e.message.includes('unexpected Content-Type') && !e.message.includes('DO-NOT-LOG'));
    assert.equal(cancelled, true); assert.equal(f.seen.length, 1);
  }
});

test('missing response body is distinguished without accepting an SSE header alone', async () => {
  const f = fixture([savedAccount()]);
  f.respond(async () => new Response(null, { headers: { 'Content-Type': 'text/event-stream' } }));
  await assert.rejects(f.app.chat(request), (e: any) => e.code === 'invalid_stream' && e.message.includes('missing body'));
});

test('invalid-stream cleanup is bounded when cancellation never settles or rejects', { timeout: 2000 }, async () => {
  for (const neverSettles of [true, false]) {
    let cancelled = false;
    const f = fixture([savedAccount()]);
    f.respond(async () => new Response(new ReadableStream({
      cancel() { cancelled = true; return neverSettles ? new Promise<void>(() => {}) : Promise.reject(new Error('DO-NOT-LOG')); },
    }), { headers: { 'Content-Type': 'application/json' } }));
    await assert.rejects(f.app.chat(request), (e: any) => e.code === 'invalid_stream' && !e.message.includes('DO-NOT-LOG'));
    assert.equal(cancelled, true);
  }
});

test('missing Content-Type and normalized explicit SSE both require and accept a completed JSON stream', async () => {
  for (const contentType of [undefined, 'text/event-stream', 'Text/Event-Stream; Charset=UTF-8']) {
    const f = fixture([savedAccount()]);
    f.respond(async () => {
      const response = stream([delta, completed], true);
      if (contentType === undefined) response.headers.delete('Content-Type');
      else response.headers.set('Content-Type', contentType);
      return response;
    });
    assert.deepEqual((await f.app.chat(request)).value, { title: 'idé' });
    const body = JSON.parse(String(f.seen[0].options.body));
    assert.equal(body.text.format.type, 'json_schema'); assert.equal(body.text.format.strict, true);
    assert.equal(body.stream, true); assert.equal(body.store, false); assert.equal(f.seen.length, 1);
  }
});

test('missing-header malformed, HTML, JSON, truncated and failed streams never succeed', async () => {
  const bodies = [
    'data: {malformed}\n\n', '<html>DO-NOT-LOG</html>', '{"connected":true}',
    `data: ${JSON.stringify(delta)}\n\n`, `data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(completed)}`,
    `data: ${JSON.stringify(delta)}\n\ndata: {"type":"response.incomplete"}\n\n`,
    `data: ${JSON.stringify(delta)}\n\ndata: {"type":"error","code":"subscription_sharing_usage_limit_exceeded","message":"DO-NOT-LOG"}\n\n`,
    `data: ${JSON.stringify(delta)}\n\ndata: {"type":"response.failed","response":{"error":{"code":"subscription_sharing_usage_unavailable"}}}\n\n`,
    `data: ${JSON.stringify(delta)}\n\ndata: {"type":"response.completed","response":{"status":"incomplete"}}\n\n`,
    `data: {"type":"response.output_text.delta","delta":"not JSON"}\n\ndata: ${JSON.stringify(completed)}\n\n`,
  ];
  for (const body of bodies) {
    const f = fixture([savedAccount()]);
    f.respond(async () => { const response = new Response(body); response.headers.delete('Content-Type'); return response; });
    await assert.rejects(f.app.chat(request), (e: any) => e instanceof Error && !e.message.includes('DO-NOT-LOG'));
    assert.equal(f.seen.length, 1);
  }
});

test('missing-header stream parsing cancels on malformed data and completion with bounded cleanup', { timeout: 2000 }, async () => {
  for (const malformed of [true, false]) {
    let cancelled = false;
    const f = fixture([savedAccount()]);
    f.respond(async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(malformed ? 'data: invalid\n\n' : `data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify(completed)}\n\n`)); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    })));
    if (malformed) await assert.rejects(f.app.chat(request), { code: 'interrupted' });
    else assert.deepEqual((await f.app.chat(request)).value, { title: 'idé' });
    assert.equal(cancelled, true);
  }
});


test('direct-admission errors retain safe diagnostics without reflecting upstream bodies or credentials', async () => {
  for (const status of [401, 403, 503]) {
    const f = fixture([savedAccount()]);
    f.respond(async () => new Response(JSON.stringify({ detail: 'PRIVATE-access-one' }), { status, headers: { 'Content-Type': 'application/json', 'x-request-id': 'req_test123' } }));
    await assert.rejects(f.app.chat(request), (e: any) => e.message.includes(`HTTP ${status}`) && e.message.includes('req_test123') && !e.message.includes('PRIVATE'));
    assert.equal(f.persisted().accounts[0].accessToken, 'access-one');
    assert.equal(f.seen.length, 1);
  }
  const f = fixture([savedAccount()]);
  f.respond(async () => reply({ error: { code: 'subscription_sharing_unsupported_capability', param: 'temperature', message: 'PRIVATE-access-one' } }, 400));
  await assert.rejects(f.app.chat(request), (e: any) => e.code === 'subscription_sharing_unsupported_capability' && e.message.includes('temperature') && !e.message.includes('PRIVATE'));
});

test('switching account interrupts an in-flight response, including buffered complete events', async () => {
  const f = fixture([savedAccount(), savedAccount('two')]);
  let resolve!: (r: Response) => void;
  f.respond(() => new Promise(r => { resolve = r; }));
  const result = f.app.chat(request);
  await new Promise(r => setImmediate(r));
  f.app.select('two'); resolve(stream([delta, completed]));
  await assert.rejects(result, { code: 'interrupted' });
  assert.equal(f.app.status().active, 'two');
});

test('signout persists disconnection before discovery completes, including restart state', async () => {
  const f = fixture([savedAccount()]);
  let resolve!: (r: Response) => void;
  f.respond(() => new Promise(r => { resolve = r; }));
  const signout = f.app.signOut('one');
  const stored = f.persisted();
  assert.equal(stored.active, undefined);
  assert.equal(stored.accounts[0].accessToken, undefined);
  assert.equal(stored.accounts[0].refreshToken, undefined);
  assert.equal(stored.accounts[0].idToken, undefined);
  const restarted = new ChatGPT({ load: () => stored, save() {}, close() {} });
  assert.equal(restarted.status().accounts[0].connected, false);
  assert.match(restarted.status().message, /revocation/);
  await assert.rejects(restarted.models(), { code: 'sign_in_required' });
  await new Promise(r => setImmediate(r));
  resolve(reply({}, 503)); await signout;
});

test('signout revokes a racing refresh replacement without persisting it', async () => {
  const f = fixture([{ ...savedAccount(), expiresAt: now }]);
  let resolve!: (r: Response) => void;
  f.respond(async url => url.endsWith('/token') ? new Promise(r => { resolve = r; })
    : url.endsWith('openid-configuration') ? reply({ issuer: 'https://auth.openai.com', revocation_endpoint: 'https://auth.openai.com/revoke' }) : new Response(''));
  const models = f.app.models();
  const signout = f.app.signOut('one');
  assert.equal(f.persisted().accounts[0].refreshToken, undefined);
  resolve(tokenReply());
  await assert.rejects(models, { code: 'stale_session' });
  assert.deepEqual(await signout, { revoked: true });
  assert.equal((f.seen.at(-1)!.options.body as URLSearchParams).get('token'), 'refresh-new');
  assert.equal(f.persisted().accounts[0].refreshToken, undefined);
});
