import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, customFetch, type JWTVerifyGetKey } from 'jose';
import type { CredentialStore, Credentials, Account } from './chatgpt-store.ts';
import type { ChatRequest, ChatResult } from './providers.ts';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const random = () => randomBytes(32).toString('base64url');
const terminalRefresh = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);

export class ChatGPTError extends Error {
  code: string;
  constructor(code: string, message: string) { super(message); this.code = code; }
}
const fail = (code: string, message: string): never => { throw new ChatGPTError(code, message); };
async function boundedCancel(cancel: () => Promise<unknown>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(cancel).catch(() => {}),
      new Promise<void>(resolve => { timer = setTimeout(resolve, 250); }),
    ]);
  } finally { clearTimeout(timer); }
}
const validClient = (id: string) => /^oaiapp_[A-Za-z0-9_-]{1,200}$/.test(id);
type Attempt = { id: string; state: string; nonce: string; verifier: string; cookie: string; redirect: string; account?: Account; clientId: string; expires: number; consumed: boolean; controller: AbortController; consent: boolean };

export function identityVerifier(jwks: JWTVerifyGetKey = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`), {
  [customFetch]: (url, options) => fetch(url, { ...options, redirect: 'error' }),
})) {
  return async (token: string, clientId: string, nonce?: string) => {
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer: ISSUER, audience: clientId, algorithms: ['RS256'],
        requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5,
      });
      if (typeof payload.sub !== 'string' || !payload.sub.trim() || (nonce !== undefined && payload.nonce !== nonce) ||
          (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) throw new Error();
      return { subject: payload.sub, email: typeof payload.email === 'string' ? payload.email : '' };
    } catch { return fail('invalid_identity', 'ChatGPT identity validation failed. Start sign-in again.'); }
  };
}

export class ChatGPT {
  private data: Credentials;
  private store: CredentialStore;
  private fetcher: typeof fetch;
  private verify: ReturnType<typeof identityVerifier>;
  private now: () => number;
  private pending?: Attempt;
  private retryClientId?: string;
  private signingOut = new Map<string, { refreshToken?: string }>();
  private refreshes = new Map<string, Promise<void>>();
  private requests = new AbortController();
  private message = '';
  private paused = new Set<string>();

  constructor(store: CredentialStore, options: { fetcher?: typeof fetch; verify?: ReturnType<typeof identityVerifier>; now?: () => number } = {}) {
    this.store = store;
    try { this.data = store.load(); } catch (e) { store.close(); throw e; }
    this.fetcher = options.fetcher ?? fetch;
    this.verify = options.verify ?? identityVerifier();
    this.now = options.now ?? Date.now;
  }
  private save() { this.store.save(this.data); }
  private expire() { if (this.pending && this.pending.expires <= this.now()) this.cancel(); }
  status() {
    this.expire();
    return { active: this.data.active ?? null, pending: !!this.pending, pendingId: this.pending?.id ?? null, message: this.message || (this.data.accounts.some(a => a.revocationUnconfirmed) ? 'A previous sign-out could not confirm remote revocation. Disconnect the app in ChatGPT Settings.' : ''),
      welcome: !this.data.welcomed && this.data.accounts.some(a => !!a.accessToken && a.scopes.includes('chatgpt.tokens.use.direct')),
      accounts: this.data.accounts.map(a => ({ id: a.id, label: `${a.email || 'ChatGPT account'} · ${a.clientId.slice(-8)}`,
        connected: !!a.accessToken, planEnabled: a.scopes.includes('chatgpt.tokens.use.direct'), paused: this.paused.has(a.id) })) };
  }
  acknowledge() { this.data.welcomed = true; this.save(); }
  cancel() { this.pending?.controller.abort(); this.pending = undefined; }
  cancelAttempt(id: string) {
    if (typeof id === 'string' && id === this.pending?.id) this.cancel();
  }
  private stopRequests() { this.requests.abort(); this.requests = new AbortController(); }
  begin(origin: string, accountId?: string, consent = false) {
    this.expire();
    if (this.signingOut.size) return fail('sign_out_pending', 'Wait for ChatGPT sign-out to finish before signing in again.');
    if (this.pending) return fail('sign_in_pending', 'Sign-in is already in progress. Cancel it before starting again.');
    const u = new URL(origin);
    if (u.protocol !== 'http:' || u.hostname !== '127.0.0.1') return fail('local_only', 'Open this app at http://127.0.0.1 on its configured port to sign in.');
    const account = accountId ? this.data.accounts.find(a => a.id === accountId) : undefined;
    if (accountId && !account) return fail('unknown_account', 'Choose a saved ChatGPT account.');
    this.save(); // Stable host ID is persisted before the first authorization.
    this.message = '';
    this.pending = { id: random(), state: random(), nonce: random(), verifier: random(), cookie: random(), redirect: `${u.origin}/auth/callback`,
      account, clientId: account?.clientId ?? this.retryClientId ?? 'dynamic_agent_client', consent, expires: this.now() + 600_000, consumed: false, controller: new AbortController() };
    return { url: `/auth/chatgpt/authorize?id=${this.pending.id}`, attemptId: this.pending.id };
  }
  authorize(id: string) {
    this.expire();
    const p = this.pending;
    if (!p || p.id !== id || p.consumed) return fail('stale_sign_in', 'This sign-in attempt has expired.');
    const url = new URL(`${ISSUER}/api/accounts/authorize`);
    url.search = new URLSearchParams({ client_id: p.clientId,
      ext_agent_host_id: this.data.hostId, response_type: 'code', redirect_uri: p.redirect, scope: SCOPES, resource: RESOURCE,
      state: p.state, nonce: p.nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(p.verifier).digest('base64url') }).toString();
    if (p.clientId === 'dynamic_agent_client') url.searchParams.set('agent_name_hint', 'Idea Generator 2');
    // ID-token hints intentionally omitted: never expose retained tokens in browser URLs.
    if (p.consent) url.searchParams.set('prompt', 'consent');
    return { url: url.href, cookie: p.cookie };
  }
  private async request(url: string, init: RequestInit = {}) {
    try {
      return await this.fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.any([init.signal ?? this.requests.signal, AbortSignal.timeout(120_000)]) });
    } catch { return fail('chatgpt_unreachable', 'ChatGPT request was interrupted or unavailable. Try again.'); }
  }
  private async token(body: Record<string, string>, signal?: AbortSignal) {
    const res = await this.request(TOKEN, { method: 'POST', body: new URLSearchParams(body), signal });
    let data: any;
    try { data = await res.json(); } catch { return fail('invalid_token_response', 'ChatGPT returned an invalid token response.'); }
    if (!res.ok) {
      const code = typeof data.error === 'string' && (terminalRefresh.has(data.error) || data.error === 'invalid_client') ? data.error : 'token_exchange_failed';
      return fail(code, 'ChatGPT authorization could not be renewed. Try signing in again if the problem persists.');
    }
    if (data.token_type?.toLowerCase() !== 'bearer' || typeof data.access_token !== 'string' || !data.access_token ||
        typeof data.refresh_token !== 'string' || !data.refresh_token || !Number.isFinite(data.expires_in) || data.expires_in <= 0) {
      return fail('invalid_token_response', 'ChatGPT returned an incomplete token response.');
    }
    return data;
  }
  private tokens(data: any, previousScopes: string[] = []) {
    return { accessToken: data.access_token, refreshToken: data.refresh_token,
      expiresAt: this.now() + data.expires_in * 1000, refreshExpiresAt: this.now() + 30 * 86400_000,
      scopes: typeof data.scope === 'string' ? data.scope.split(/\s+/) : previousScopes };
  }
  async callback(params: URLSearchParams, cookie: string) {
    this.expire();
    const p = this.pending;
    // Reject duplicate security parameters, stale callbacks and callbacks from another browser.
    if (!p || p.consumed || params.getAll('state').length !== 1 || params.get('state') !== p.state || cookie !== p.cookie) {
      return fail('invalid_state', 'Invalid or expired ChatGPT sign-in.');
    }
    p.consumed = true;
    try {
      if (params.has('error')) return fail('consent_declined', 'ChatGPT sign-in was cancelled or permission was declined.');
      const clientId = params.get('client_id') ?? (p.clientId === 'dynamic_agent_client' ? '' : p.clientId);
      if (!validClient(clientId) || params.getAll('client_id').length > 1 || (p.clientId !== 'dynamic_agent_client' && p.clientId !== clientId)) return fail('invalid_client', 'ChatGPT returned a different or missing client registration.');
      const code = params.get('code');
      if (!code || params.getAll('code').length !== 1) return fail('invalid_code', 'ChatGPT did not return an authorization code.');
      p.clientId = clientId;
      const data = await this.token({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: p.verifier, redirect_uri: p.redirect, resource: RESOURCE }, p.controller.signal);
      if (typeof data.id_token !== 'string') return fail('invalid_identity', 'ChatGPT did not return an identity token.');
      const identity = await this.verify(data.id_token, clientId, p.nonce);
      const existing = this.data.accounts.find(a => a.clientId === clientId);
      if ((p.account && p.account.subject !== identity.subject) || (existing && existing.subject !== identity.subject)) return fail('account_mismatch', 'ChatGPT returned a different account.');
      if (this.pending !== p || p.controller.signal.aborted) return fail('stale_sign_in', 'This sign-in was cancelled.');
      const account: Account = { id: existing?.id ?? randomUUID(), clientId, ...identity, ...this.tokens(data), idToken: data.id_token };
      this.retryClientId = undefined;
      this.stopRequests();
      this.data.accounts = this.data.accounts.filter(a => a.id !== account.id).concat(account);
      this.data.active = account.id;
      this.paused.delete(account.id);
      this.save();
      this.message = account.scopes.includes('chatgpt.tokens.use.direct') ? 'Using ChatGPT plan' : 'Signed in. ChatGPT plan permission is disabled; enable it or choose another provider.';
    } catch (e) {
      if (this.pending === p && e instanceof ChatGPTError && e.code === 'invalid_grant' && !p.account && validClient(p.clientId)) this.retryClientId = p.clientId;
      if (this.pending === p) this.message = e instanceof ChatGPTError ? e.message : 'ChatGPT sign-in failed.';
      throw e;
    } finally { if (this.pending === p) this.pending = undefined; }
  }
  select(id: string) {
    const account = this.data.accounts.find(a => a.id === id);
    if (!account?.accessToken) return fail('sign_in_required', 'Sign in to this saved ChatGPT account first.');
    this.cancel(); this.stopRequests(); this.data.active = id; this.save();
  }
  private clearTokens(account: Account) {
    delete account.accessToken; delete account.refreshToken; delete account.idToken;
    delete account.expiresAt; delete account.refreshExpiresAt; account.scopes = [];
  }
  private async refresh(account: Account) {
    if (this.refreshes.has(account.id)) return this.refreshes.get(account.id);
    const promise = (async () => {
      try {
        if (!account.refreshToken || (account.refreshExpiresAt ?? 0) <= this.now()) return fail('refresh_token_expired', 'Sign in to ChatGPT again.');
        const old = account.refreshToken;
        const data = await this.token({ grant_type: 'refresh_token', client_id: account.clientId, refresh_token: old, resource: RESOURCE });
        const signingOut = this.signingOut.get(account.id);
        if (signingOut) { signingOut.refreshToken = data.refresh_token; return; }
        if (data.id_token) {
          const identity = await this.verify(data.id_token, account.clientId);
          if (identity.subject !== account.subject) return fail('account_mismatch', 'ChatGPT returned a different account.');
        }
        if (account.refreshToken !== old || !this.data.accounts.includes(account)) return fail('stale_session', 'ChatGPT session changed. Try again.');
        Object.assign(account, this.tokens(data, account.scopes), data.id_token ? { idToken: data.id_token } : {});
        this.save();
      } catch (e: any) {
        if (terminalRefresh.has(e.code)) { this.clearTokens(account); this.save(); }
        throw e;
      }
    })();
    this.refreshes.set(account.id, promise);
    try { await promise; } finally { this.refreshes.delete(account.id); }
  }
  async signOut(id: string) {
    const account = this.data.accounts.find(a => a.id === id);
    if (!account) return fail('unknown_account', 'Choose a saved ChatGPT account.');
    if (this.signingOut.has(id)) return fail('sign_out_pending', 'ChatGPT sign-out is already in progress.');
    const session = { refreshToken: account.refreshToken };
    this.signingOut.set(id, session);
    this.cancel(); this.stopRequests();
    this.clearTokens(account);
    account.revocationUnconfirmed = !!session.refreshToken;
    if (this.data.active === id) delete this.data.active;
    // Durable local sign-out happens before ANY remote wait. A refresh already in
    // flight can hand its replacement to session, but cannot restore credentials.
    try { this.save(); } catch (e) { this.signingOut.delete(id); throw e; }
    let revoked = !session.refreshToken;
    try {
      await this.refreshes.get(id)?.catch(() => {});
      if (session.refreshToken) {
        const discovery = await this.request(`${ISSUER}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
        const config = await discovery.json();
        const endpoint = new URL(config.revocation_endpoint);
        if (!discovery.ok || config.issuer !== ISSUER || endpoint.origin !== ISSUER || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error();
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            const res = await this.request(endpoint.href, { method: 'POST', signal: AbortSignal.timeout(10_000), body: new URLSearchParams({ token: session.refreshToken, token_type_hint: 'refresh_token', client_id: account.clientId }) });
            revoked = res.status === 200;
            if (res.status < 500) break;
          } catch { /* Retry one transient failure before reporting unconfirmed revocation. */ }
          if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 250));
        }
      }
    } catch { /* Local sign-out has already finished. */ }
    finally { this.signingOut.delete(id); }
    account.revocationUnconfirmed = !revoked;
    this.save();
    this.message = revoked ? 'Signed out of ChatGPT.' : 'Signed out locally. Remote revocation was not confirmed; disconnect this app in ChatGPT Settings.';
    return { revoked };
  }
  private async access() {
    const account = this.data.accounts.find(a => a.id === this.data.active);
    if (!account?.accessToken) return fail('sign_in_required', 'Continue with ChatGPT in Settings first.');
    if ((account.expiresAt ?? 0) <= this.now() + 60_000) await this.refresh(account);
    if (account.id !== this.data.active || !account.accessToken) return fail('stale_session', 'ChatGPT account changed. Try again.');
    if (!account.scopes.includes('chatgpt.tokens.use.direct') || !account.scopes.includes('resource.invoke')) return fail('plan_disabled', 'Enable ChatGPT plan usage in Settings or choose another provider.');
    return account;
  }
  private apiError(data: any, status: number, account: Account, requestId: string | null = null): never {
    // Never echo upstream messages: they can contain credentials or request content.
    const allowed = new Set(['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable', 'subscription_sharing_user_not_eligible', 'subscription_sharing_unsupported_capability', 'subscription_sharing_route_not_supported', 'subscription_sharing_invalid_user', 'subscription_sharing_user_unavailable', 'chatpass_v2_scope_not_authorized', 'chatpass_v2_invalid_authorization_context']);
    const error = data?.error && typeof data.error === 'object' ? data.error : data;
    const code = allowed.has(error?.code) ? error.code : 'chatgpt_request_failed';
    const param = typeof error?.param === 'string' && /^[a-z_][a-z0-9_.\[\]]{0,79}$/.test(error.param) ? error.param : null;
    const id = requestId && /^req_[A-Za-z0-9_-]{1,100}$/.test(requestId) ? requestId : null;
    const diagnostics = [status ? `HTTP ${status}` : 'stream', code, param ? `parameter ${param}` : '', id ?? ''].filter(Boolean).join('; ');
    const recovery = status === 401 ? 'Check the selected ChatGPT account and granted plan permission.'
      : status === 403 ? 'Account eligibility, workspace, region or client policy prevented this request. Check permissions; repeating sign-in may not help.'
      : status === 503 ? 'ChatGPT is temporarily unavailable. Credentials were preserved; try again later.'
      : 'Check account permissions and supported request capabilities.';
    if (code === 'subscription_sharing_usage_limit_exceeded') this.paused.add(account.id);
    return fail(code, `ChatGPT request failed (${diagnostics}). ${this.paused.has(account.id) ? 'Usage limit reached. Manage usage in ChatGPT Settings, then resume explicitly.' : recovery} No other billing provider was used.`);
  }
  resume() { if (this.data.active) this.paused.delete(this.data.active); }
  async models() {
    const account = await this.access();
    const res = await this.request(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${account.accessToken}` } });
    let data: any; try { data = await res.json(); } catch { return fail('invalid_catalog', 'ChatGPT returned an invalid model catalog.'); }
    if (!res.ok) return this.apiError(data, res.status, account, res.headers.get('x-request-id'));
    if (account.id !== this.data.active || !account.accessToken) return fail('stale_session', 'ChatGPT account changed. Load models again.');
    if (!Array.isArray(data.models)) return fail('invalid_catalog', 'ChatGPT returned an invalid model catalog.');
    return data.models.filter((m: any) => m.visibility === 'list' && typeof m.slug === 'string' && typeof m.display_name === 'string')
      .map((m: any) => ({ slug: m.slug, displayName: m.display_name }));
  }
  async chat(r: ChatRequest): Promise<ChatResult> {
    if (r.plugins) return fail('no_search', 'The X scout needs OpenRouter; ChatGPT does not use OpenRouter plugins.');
    const account = await this.access();
    if (this.paused.has(account.id)) return fail('subscription_sharing_usage_limit_exceeded', 'ChatGPT usage is paused. Manage usage in ChatGPT Settings, then resume explicitly.');
    const signal = this.requests.signal;
    const res = await this.request(`${RESOURCE}/responses`, { method: 'POST', signal,
      headers: { Authorization: `Bearer ${account.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: r.model.slice('chatgpt:'.length), instructions: r.system,
        input: [{ role: 'user', content: r.user }], store: false, stream: true,
        text: { format: { type: 'json_schema', name: r.schemaName, strict: true, schema: r.schema } } }) });
    if (!res.ok) { let data; try { data = await res.json(); } catch {} return this.apiError(data, res.status, account, res.headers.get('x-request-id')); }
    const contentType = res.headers.get('content-type');
    const mime = contentType?.split(';', 1)[0].trim().toLowerCase();
    // Some live Responses streams omit Content-Type. Accept no result until the
    // same SSE parser, completed-status check and JSON validation succeed below.
    if (!res.body || (contentType !== null && mime !== 'text/event-stream')) {
      const reason = !res.body ? 'missing body' : 'unexpected Content-Type';
      if (res.body) {
        // Rejecting the format must also stop unused inference/network output.
        // Some stream sources never settle cancellation, so bound cleanup.
        await boundedCancel(() => res.body!.cancel());
      }
      return fail('invalid_stream', `ChatGPT did not return an event stream (${reason}).`);
    }
    let output = '';
    try {
      for await (const event of responseEvents(res.body)) {
        if (signal.aborted || this.data.active !== account.id || !account.accessToken) return fail('interrupted', 'ChatGPT request was interrupted.');
        if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') output += event.delta;
        if (output.length > 2_000_000) return fail('response_too_large', 'ChatGPT response exceeded the local limit.');
        if (event.type === 'response.failed' || event.type === 'error') return this.apiError(event.response ?? event, 0, account, res.headers.get('x-request-id'));
        if (event.type === 'response.incomplete') return fail('incomplete_response', 'ChatGPT response was incomplete. Try again.');
        if (event.type === 'response.completed') {
          if (event.response?.status !== 'completed') return fail('incomplete_response', 'ChatGPT did not complete the response.');
          try { return { value: JSON.parse(output), costUsd: 0 }; }
          catch { return fail('invalid_output', 'ChatGPT did not return the requested JSON object.'); }
        }
      }
    } catch (e) { if (e instanceof ChatGPTError) throw e; return fail('interrupted', 'ChatGPT response was interrupted. Try again.'); }
    return fail('interrupted', 'ChatGPT stream ended without completion. Try again.');
  }
  close() { this.cancel(); this.stopRequests(); this.store.close(); }
}

/** Incremental SSE decoding, including UTF-8 and CRLF split across chunks. */
export async function* responseEvents(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', data: string[] = [], eventSize = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (buffer.length > 2_000_000) return fail('response_too_large', 'ChatGPT event exceeded the local limit.');
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end).replace(/\r$/, ''); buffer = buffer.slice(end + 1);
        if (!line) {
          if (data.length) { const raw = data.join('\n'); data = []; eventSize = 0; if (raw !== '[DONE]') yield JSON.parse(raw); }
        } else if (line.startsWith('data:')) {
          eventSize += line.length;
          if (eventSize > 2_000_000) return fail('response_too_large', 'ChatGPT event exceeded the local limit.');
          data.push(line.slice(5).replace(/^ /, ''));
        }
      }
      if (done) break;
    }
  } finally { await boundedCancel(() => reader.cancel()); reader.releaseLock(); }
}
