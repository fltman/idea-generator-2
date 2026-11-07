// Provider adapters against local fake servers: the request shapes we send
// and the fallbacks we take. (Real providers are exercised by `npm run calibrate`.)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import {
  DEFAULT_APP_SETTINGS, extractJson, keyFor, listModels, makeChat, mergeAppSettings, parseModel, ProviderError, type AppSettings,
} from '../server/providers.ts';

type Seen = { path: string; headers: Record<string, any>; body: any };
const seen: Seen[] = [];
let script: ((s: Seen) => { status: number; body: unknown }) | null = null;
let server: Server;
let base = '';

before(async () => {
  server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const s: Seen = { path: req.url!, headers: req.headers, body: raw ? JSON.parse(raw) : null };
    seen.push(s);
    const out = script ? script(s) : { status: 404, body: { error: 'no script' } };
    res.writeHead(out.status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(out.body));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
  // The Anthropic SDK reads its base URL from the environment.
  process.env.ANTHROPIC_BASE_URL = base;
});
after(() => server.close());

const schema = { type: 'object', properties: { title: { type: 'string' } }, required: ['title'], additionalProperties: false };
const req = (model: string) => ({ model, system: 'sys', user: 'usr', schemaName: 'idea', schema, temperature: 0.9 });
const settingsWith = (patch: Partial<AppSettings>): AppSettings => ({ ...structuredClone(DEFAULT_APP_SETTINGS), ...patch });
const oaiAnswer = (content: string, extra: object = {}) => ({ choices: [{ message: { content, ...extra } }], usage: { cost: 0.002 } });

test('model references: provider prefix, Ollama tags, bare OpenRouter slugs', () => {
  assert.deepEqual(parseModel('openrouter:anthropic/claude-sonnet-5.5'), { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5' });
  assert.deepEqual(parseModel('ollama:qwen3:8b'), { provider: 'ollama', model: 'qwen3:8b' });
  assert.deepEqual(parseModel('anthropic/claude-sonnet-5.5'), { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5' });
  assert.deepEqual(parseModel('anthropic:claude-opus-5-5'), { provider: 'anthropic', model: 'claude-opus-5-5' });
});

test('settings from the browser are merged onto defaults, junk dropped', () => {
  const s = mergeAppSettings({
    keys: { openrouter: ' sk-1 ', nope: 'x' }, baseUrls: { ollama: 'http://box:11434///' },
    models: { judge: 'ollama:qwen3:8b', bogus: 'x' }, projectsRoot: 'relative/path', maxUsdPerDay: -1,
  });
  assert.equal(s.keys.openrouter, 'sk-1');
  assert.equal((s.keys as any).nope, undefined);
  assert.equal(s.baseUrls.ollama, 'http://box:11434');
  assert.equal(s.models.judge, 'ollama:qwen3:8b');
  assert.equal(s.models.expand, DEFAULT_APP_SETTINGS.models.expand);
  assert.equal(s.projectsRoot, DEFAULT_APP_SETTINGS.projectsRoot, 'a relative path is refused');
  assert.equal(mergeAppSettings({ projectsRoot: '/srv/ideas' }).projectsRoot, '/srv/ideas');
  assert.equal(mergeAppSettings({ projectsRoot: '~/ideas' }).projectsRoot, '~/ideas');
  if (process.platform === 'win32') assert.equal(mergeAppSettings({ projectsRoot: 'E:\\ideas' }).projectsRoot, 'E:\\ideas', 'a Windows drive path is absolute');
  assert.equal(s.maxUsdPerDay, DEFAULT_APP_SETTINGS.maxUsdPerDay);
});

test('a key typed in the browser wins over the environment', () => {
  const prev = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = 'from-env';
  assert.equal(keyFor(settingsWith({}), 'openai'), 'from-env');
  assert.equal(keyFor(settingsWith({ keys: { openai: 'from-browser' } }), 'openai'), 'from-browser');
  if (prev === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = prev;
});

test('JSON is dug out of thinking tags, code fences and prose', () => {
  assert.deepEqual(extractJson('<think>hmm {no}</think>\n```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(extractJson('Here you go: {"a":{"b":2}} hope that helps'), { a: { b: 2 } });
  assert.throws(() => extractJson('no json here'));
});

test('OpenAI-compatible: strict json_schema, Bearer key, cost from usage', async () => {
  script = () => ({ status: 200, body: oaiAnswer('{"title":"Ok"}') });
  const chat = makeChat(() => settingsWith({ baseUrls: { custom: base }, keys: { custom: 'k1' } }));
  const out = await chat(req('custom:my-model'));
  assert.deepEqual(out.value, { title: 'Ok' });
  assert.equal(out.costUsd, 0.002);
  const s = seen.at(-1)!;
  assert.equal(s.path, '/chat/completions');
  assert.equal(s.headers.authorization, 'Bearer k1');
  assert.equal(s.body.model, 'my-model');
  assert.equal(s.body.response_format.type, 'json_schema');
  assert.equal(s.body.response_format.json_schema.strict, true);
});

test('OpenAI-compatible: falls back to JSON-in-prompt when structured output is refused, drops temperature when refused', async () => {
  seen.length = 0;
  script = (s) => {
    if (s.body.response_format) return { status: 400, body: { error: 'response_format json_schema is not supported' } };
    if ('temperature' in s.body) return { status: 400, body: { error: 'Unsupported value: temperature' } };
    return { status: 200, body: oaiAnswer('Sure! {"title":"Fallback"}') };
  };
  const chat = makeChat(() => settingsWith({ baseUrls: { lmstudio: base } }));
  const out = await chat(req('lmstudio:local-model'));
  assert.deepEqual(out.value, { title: 'Fallback' });
  assert.equal(seen.length, 3);
  assert.match(seen[2].body.messages[0].content, /JSON Schema/, 'the schema moved into the prompt');
  assert.equal(seen[2].headers.authorization, undefined, 'local providers need no key');
});

test('Azure uses an api-key header; 401 is a bad key, not a retry', async () => {
  seen.length = 0;
  script = () => ({ status: 401, body: { error: 'bad key' } });
  const chat = makeChat(() => settingsWith({ baseUrls: { azure: base }, keys: { azure: 'az' } }));
  await assert.rejects(chat(req('azure:my-deployment')), (e: any) => e instanceof ProviderError && e.code === 'bad_key');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].headers['api-key'], 'az');
  assert.equal(seen[0].headers.authorization, undefined);
});

test('missing key and missing search are explained, not sent', async () => {
  const prev = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const chat = makeChat(() => settingsWith({}));
  await assert.rejects(chat(req('openai:gpt-5.4-mini')), (e: any) => e.code === 'no_key');
  await assert.rejects(chat({ ...req('ollama:qwen3:8b'), plugins: [{ id: 'web' }] }), (e: any) => e.code === 'no_search');
  if (prev !== undefined) process.env.OPENAI_API_KEY = prev;
});

test('Ollama: native API with think:false and the schema as format', async () => {
  seen.length = 0;
  script = (s) =>
    'think' in s.body && s.body.model === 'no-think'
      ? { status: 400, body: { error: '"no-think" does not support thinking' } }
      : { status: 200, body: { message: { content: '{"title":"Lokal"}' } } };
  const chat = makeChat(() => settingsWith({ baseUrls: { ollama: base } }));
  const out = await chat(req('ollama:qwen3:8b'));
  assert.deepEqual(out.value, { title: 'Lokal' });
  assert.equal(out.costUsd, 0);
  assert.equal(seen[0].path, '/api/chat');
  assert.equal(seen[0].body.think, false);
  assert.deepEqual(seen[0].body.format, schema);
  assert.equal(seen[0].body.stream, false);
  await chat(req('ollama:no-think'));
  assert.ok(!('think' in seen.at(-1)!.body), 'retried without think');
});

test('Anthropic (SDK): output_config with JSON schema and low effort, no temperature, cost from usage', async () => {
  seen.length = 0;
  script = () => ({
    status: 200,
    body: {
      id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', stop_reason: 'end_turn', stop_sequence: null,
      content: [{ type: 'text', text: '{"title":"Från Claude"}' }], usage: { input_tokens: 1000, output_tokens: 100 },
    },
  });
  const chat = makeChat(() => settingsWith({ keys: { anthropic: 'sk-ant-test' } }));
  const out = await chat(req('anthropic:claude-sonnet-5-5'));
  assert.deepEqual(out.value, { title: 'Från Claude' });
  assert.equal(out.costUsd, (1000 * 2 + 100 * 10) / 1e6);
  const s = seen.at(-1)!;
  assert.equal(s.path, '/v1/messages');
  // The SDK decides how the key travels (API version 2026-10-21 sends it as a Bearer token).
  assert.ok(s.headers.authorization === 'Bearer sk-ant-test' || s.headers['x-api-key'] === 'sk-ant-test');
  assert.deepEqual(s.body.output_config, { format: { type: 'json_schema', schema }, effort: 'low' });
  assert.ok(!('temperature' in s.body));
  assert.equal(s.body.system, 'sys');
});

test('model lists double as a connection test', async () => {
  script = (s) =>
    s.path === '/api/tags' ? { status: 200, body: { models: [{ name: 'qwen3:8b' }, { name: 'gemma3:4b' }] } }
    : { status: 200, body: { data: [{ id: 'b' }, { id: 'a' }] } };
  assert.deepEqual(await listModels(settingsWith({ baseUrls: { ollama: base } }), 'ollama'), ['qwen3:8b', 'gemma3:4b']);
  assert.deepEqual(await listModels(settingsWith({ baseUrls: { mlx: base } }), 'mlx'), ['a', 'b']);
  await assert.rejects(listModels(settingsWith({ baseUrls: { mlx: 'http://127.0.0.1:1' } }), 'mlx'), (e: any) => e.code === 'unreachable');
});
