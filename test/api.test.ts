// The whole HTTP API against an in-memory database and a fake LLM.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb } from '../server/db.ts';
import { createEngine } from '../server/engine.ts';
import { createAutopilot } from '../server/autopilot.ts';
import { createHandler } from '../server/app.ts';
import { DEFAULT_APP_SETTINGS, ProviderError, type AppSettings, type ChatRequest } from '../server/providers.ts';

const calls: ChatRequest[] = [];
let judgeScores = { originality: 3, feasibility: 3, impact: 3 };
let judgeKeywords = ['Public Space', 'sound'];
let failNext: Error | null = null;
let xCitations: string[] = [];
let holdChat: Promise<void> | null = null; // while set, every model call waits for it

// Fake chat: answers by schema name, records every request.
async function fakeChat(r: ChatRequest) {
  calls.push(r);
  if (holdChat) await holdChat;
  if (failNext) {
    const e = failNext;
    failNext = null;
    throw e;
  }
  const n = calls.length;
  const value =
    r.schemaName === 'expand' ? { ideas: [1, 2, 3].map((k) => ({ title: `"Barn ${n}.${k}."`, pitch: `Pitch ${k}` })) }
    : r.schemaName === 'judgement' ? { reason: 'Stark mekanism, oklar kund.', ...judgeScores, keywords: judgeKeywords }
    : r.schemaName === 'summary' ? { headline: 'Tavlan rör sig mot ljud.', themes: [{ name: 'Ljud', insight: 'Allt låter.', ideas: ['Lånecyklar'] }], strongest: [{ title: 'Korsning', why: 'Konkret.' }], gaps: ['Ingen tänker på natten.'], nextSteps: ['Korsa A och B.'] }
    : r.schemaName === 'synthesis' ? { headline: 'Bänkarna dominerar.', insights: ['i1', 'i2', 'i3'], standouts: [{ title: 'Sjungande parkbänk', board: 'X', why: 'w' }], opportunities: ['o1', 'o2'], nextSteps: ['n1', 'n2'] }
    : r.schemaName === 'brief' ? { name: 'Sjungande bänk', slug: 'Sjungande Bänk!', oneLiner: 'En bänk som sjunger.', problem: 'P', audience: 'A', mvp: ['m1', 'm2'], outOfScope: ['o'], stack: 's', firstSteps: ['f1', 'f2'], openQuestions: ['q1'], risks: ['r1'] }
    : r.schemaName === 'leads' ? { leads: [
        { title: 'Trend A', summary: 'S', hook: 'H', url: 'https://x.com/a/status/1' },
        { title: 'Trend B', summary: 'S', hook: 'H', url: 'https://twitter.com/b/status/2?s=20' },
        { title: 'Made up', summary: 'S', hook: 'H', url: 'https://x.com/fake/status/3' },
      ] }
    : r.schemaName === 'research' ? { leads: [
        { id: '2610.1', title: 'Rumsljud', summary: 'S', hook: 'H' },
        { id: '9999.9', title: 'Påhittad', summary: 'S', hook: 'H' },
      ] }
    : { title: r.schemaName === 'seed' ? 'Destillerat frö' : 'Korsning', pitch: 'En kombinerad pitch.' };
  return { value, costUsd: 0.001, citations: r.schemaName === 'leads' ? xCitations : [] };
}

const projectsRoot = mkdtempSync(join(tmpdir(), 'ideagen-projects-'));
let settings: AppSettings = { ...structuredClone(DEFAULT_APP_SETTINGS), projectsRoot };
let received = false;
const runtime = { get: () => settings, set: (s: AppSettings) => { settings = s; received = true; }, received: () => received };

const repo = openDb(':memory:');
const revealed: string[] = [];
let revealFails = false;
const pages: Record<string, { title: string; text: string }> = {
  'https://example.com/artikel': { title: 'Artikel', text: 'Lång artikeltext om lånecyklar. '.repeat(10) },
  'https://example.com/tom': { title: '', text: 'kort' },
};
const engine = createEngine({
  repo, chat: fakeChat, settings: () => settings, gitInit: false,
  fetchPage: async (url) => {
    if (!pages[url]) throw new Error('HTTP 404');
    return pages[url];
  },
  fetchPapers: async () => [
    { id: '2610.1', title: 'Spatial audio', summary: 'sum', published: '2026-10-30', upvotes: 9 },
    { id: '2610.2', title: 'Other', summary: 'sum', published: '2026-10-29', upvotes: 1 },
  ],
  reveal: async (p) => {
    if (revealFails) throw new Error('Cannot show the folder: xdg-open is not installed on the server');
    revealed.push(p);
  },
});
const autopilot = createAutopilot({ repo, engine, settings: () => settings });
let server: Server;
let base = '';

before(async () => {
  server = createServer(createHandler({ repo, engine, autopilot, runtime, publicDir: join(import.meta.dirname, '..', 'public') }));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as any).port}`;
});
after(() => server.close());

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const type = res.headers.get('content-type') ?? '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
}
const newBoard = async (extra: object = {}) => (await api('POST', '/api/boards', { lang: 'sv', ...extra })).data.board;
const seed = async (boardId: number, text: string) => (await api('POST', `/api/boards/${boardId}/seed`, { text })).data.idea;
const lastCall = (schema: string) => [...calls].reverse().find((c) => c.schemaName === schema)!;

test('full loop: seed → background judge → expand → combine → export', async () => {
  judgeScores = { originality: 3, feasibility: 3, impact: 3 };
  const board = await newBoard({ goal: 'Färre bilresor i staden' });
  assert.equal(board.title, 'Ny tavla');
  assert.equal(board.config.mode, 'manual');
  assert.equal(board.config.flowName, 'Uppfinnaren · Inventor', 'the first template seeds the flow');

  const before = calls.length;
  const s = await seed(board.id, 'Lånecyklar');
  assert.equal(s.title, 'Lånecyklar');
  await engine.idle();
  assert.equal(calls.length, before + 1, 'a short seed needs no LLM call, only the judge');
  assert.match(lastCall('judgement').user, /Färre bilresor i staden/, 'the judge sees the goal');
  const judged = repo.getIdea(s.id)!;
  assert.equal(judged.originality, 3);
  assert.deepEqual(judged.keywords, ['public space', 'sound'], 'keywords are normalised');

  const { data: e } = await api('POST', `/api/ideas/${s.id}/expand`, {});
  assert.equal(e.ideas.length, 3);
  assert.match(e.ideas[0].title, /^Barn \d+\.1$/, 'quotes and trailing period are stripped');
  assert.match(lastCall('expand').user, /Every idea must serve this goal/);
  assert.match(lastCall('expand').user, /- Lånecyklar/, 'existing titles reach the prompt');
  await engine.idle();
  assert.ok(e.ideas.every((i: any) => repo.getIdea(i.id)!.judgedAt), 'children are judged in the background');

  const [c1, c2] = e.ideas;
  const { data: c } = await api('POST', `/api/boards/${board.id}/combine`, { a: c1.id, b: c2.id });
  assert.equal(c.idea.generation, 2);
  await engine.idle();
  judgeScores = { originality: 9, feasibility: 0, impact: 4 }; // out of range on purpose
  const { data: j } = await api('POST', `/api/ideas/${c.idea.id}/judge`, {});
  assert.deepEqual([j.idea.originality, j.idea.feasibility, j.idea.impact], [5, 1, 4], 'scores are clamped');

  const { data: md } = await api('GET', `/api/boards/${board.id}/export.md?lang=sv`);
  assert.match(md, /^# Ny tavla/);
  assert.match(md, /> Färre bilresor i staden/);
  assert.match(md, /## 🥉 Korsning — 10\/15/, '10/15 is bronze');
  assert.match(md, /`public space` `sound`/);
  assert.ok(repo.spentOn(board.id) > 0, 'spend lands on the board');
  judgeScores = { originality: 3, feasibility: 3, impact: 3 };
});

test('each role uses its own model: app-wide setting, overridden per board', async () => {
  const pushed = await api('PUT', '/api/runtime-settings', {
    ...settings, models: { ...settings.models, expand: 'ollama:qwen3:8b' }, keys: { openrouter: 'sk-or-secret-123' },
  });
  assert.ok(!JSON.stringify(pushed.data).includes('sk-or-secret-123'), 'keys are never echoed back');
  assert.equal(pushed.data.providers.find((p: any) => p.id === 'openrouter').keySource, 'browser');
  assert.equal(pushed.data.settingsReceived, true);

  const board = await newBoard();
  const s = await seed(board.id, 'Rot');
  await api('POST', `/api/ideas/${s.id}/expand`, {});
  assert.equal(lastCall('expand').model, 'ollama:qwen3:8b');

  await api('PATCH', `/api/boards/${board.id}`, { config: { models: { expand: 'anthropic:claude-opus-5-5' } } });
  await api('POST', `/api/ideas/${s.id}/expand`, {});
  assert.equal(lastCall('expand').model, 'anthropic:claude-opus-5-5', 'board override wins');
  await api('PATCH', `/api/boards/${board.id}`, { config: { models: { expand: '' } } });
  await api('POST', `/api/ideas/${s.id}/expand`, {});
  assert.equal(lastCall('expand').model, 'ollama:qwen3:8b', 'an empty override falls back to the app setting');
  await engine.idle();
  settings = { ...structuredClone(DEFAULT_APP_SETTINGS), projectsRoot };
});

test('board config is validated and clamped', async () => {
  const board = await newBoard();
  const { data } = await api('PATCH', `/api/boards/${board.id}`, {
    config: { mode: 'chaos', rate: { stepsPerHour: 0, usdPerDay: -3 }, autopilotSeconds: 1, flow: { system: '' }, lang: 'de' },
  });
  const c = data.board.config;
  assert.equal(c.mode, 'manual');
  assert.equal(c.rate.stepsPerHour, 1);
  assert.equal(c.rate.usdPerDay, 0);
  assert.equal(c.autopilotSeconds, 3);
  assert.ok(c.flow.system.length > 20, 'an empty prompt keeps the old one');
  assert.equal(c.lang, 'sv');
});

test('the judge turns gold into a Claude Code project; a board can switch that off', async () => {
  judgeScores = { originality: 5, feasibility: 4, impact: 5 };
  const board = await newBoard({ goal: 'Ljud i offentliga rum' });
  const s = await seed(board.id, 'Sjungande parkbänk');
  await engine.idle();
  const gold = repo.getIdea(s.id)!;
  assert.ok(gold.projectPath, 'gold → project');
  assert.ok(gold.projectPath!.startsWith(projectsRoot));
  assert.match(gold.projectPath!, /sjungande-bank$/, 'slug is ASCII');
  const claude = readFileSync(join(gold.projectPath!, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /^# Sjungande bänk/);
  assert.match(claude, /Ljud i offentliga rum/);
  assert.match(claude, /14\/15 🥇/);
  assert.ok(existsSync(join(gold.projectPath!, 'vault', 'Home.md')));
  assert.match(readFileSync(join(gold.projectPath!, '.gitignore'), 'utf8'), /^vault\/$/m);

  const again = await api('POST', `/api/ideas/${s.id}/project`, {});
  assert.equal(again.data.existed, true, 'one project per idea');
  await api('POST', `/api/ideas/${s.id}/reveal`, {});
  assert.deepEqual(revealed, [gold.projectPath]);
  revealFails = true;
  const failed = await api('POST', `/api/ideas/${s.id}/reveal`, {});
  revealFails = false;
  assert.equal(failed.status, 500, 'a reveal that did not open is not ok');
  assert.equal(failed.data.code, 'reveal_failed');
  assert.match(failed.data.error, /xdg-open is not installed/);

  const off = await newBoard();
  await api('PATCH', `/api/boards/${off.id}`, { config: { autoProjectOnGold: false } });
  const s2 = await seed(off.id, 'Ännu en guldidé');
  await engine.idle();
  assert.equal(repo.getIdea(s2.id)!.projectPath, null);
  judgeScores = { originality: 3, feasibility: 3, impact: 3 };
});

test('announce: guests cross-breed on other boards, judged against their goals', async () => {
  const a = await newBoard({ title: 'Ljud', goal: 'Ljudkonst' });
  const b = await newBoard({ title: 'Trafik', goal: 'Färre bilar' });
  const c = await newBoard({ title: 'Mat', goal: 'Mindre matsvinn' });
  const idea = await seed(a.id, 'Visslande trafikljus');
  await engine.idle();

  const { data } = await api('POST', `/api/ideas/${idea.id}/announce`, { boardIds: [a.id, b.id, c.id, b.id] });
  assert.deepEqual(data.guests.map((g: any) => g.boardId).sort(), [b.id, c.id].sort(), 'not to its own board, once per board');
  const guest = data.guests.find((g: any) => g.boardId === b.id).idea;
  assert.equal(guest.kind, 'guest');
  assert.equal(guest.originBoardTitle, 'Ljud');
  await engine.idle();
  const guestJudge = calls.filter((x) => x.schemaName === 'judgement' && x.user.includes('Visslande trafikljus'));
  assert.ok(guestJudge.some((x) => x.user.includes('Färre bilar')), "judged against the target board's goal");

  const again = await api('POST', `/api/ideas/${idea.id}/announce`, { boardIds: 'all' });
  assert.ok(!again.data.guests.some((g: any) => [b.id, c.id].includes(g.boardId)), 'never twice on the same board');
  assert.ok([b.id, c.id].every((id) => again.data.skipped.includes(id)));
  const onward = await api('POST', `/api/ideas/${guest.id}/announce`, { boardIds: [a.id] });
  assert.equal(onward.data.guests.length, 0, 'a guest cannot be announced back to its original board');

  const local = await seed(b.id, 'Cykelfiler');
  const { data: child } = await api('POST', `/api/boards/${b.id}/combine`, { a: guest.id, b: local.id });
  const lineage = repo.lineage(child.idea.id);
  assert.ok(lineage.some((i) => i.title === 'Visslande trafikljus') && lineage.some((i) => i.title === 'Cykelfiler'));
  assert.ok(lineage.some((i) => i.boardId === a.id), 'lineage follows the guest home');
  await engine.idle();
});

test('spin-off: a new board grown from one idea, refined in its own context', async () => {
  const parent = await newBoard({ title: 'Mor', goal: 'Allt' });
  await api('PATCH', `/api/boards/${parent.id}`, { config: { judgeGuidance: 'Belöna lokalt.', mode: 'auto' } });
  const idea = await seed(parent.id, 'Ljudande busshållplats');
  const { data } = await api('POST', `/api/ideas/${idea.id}/spinoff`, {});
  assert.equal(data.board.goal, 'Ljudande busshållplats');
  assert.equal(data.board.config.judgeGuidance, 'Belöna lokalt.', 'config is copied');
  assert.equal(data.board.config.mode, 'manual', 'but it starts manual');
  assert.equal(data.board.originBoardTitle, 'Mor');
  assert.equal(data.idea.originIdeaId, idea.id);
  const { data: p } = await api('GET', `/api/boards/${parent.id}`);
  assert.deepEqual(p.spinoffs, [{ ideaId: idea.id, boardId: data.board.id, title: 'Ljudande busshållplats' }]);
  await api('PATCH', `/api/boards/${parent.id}`, { config: { mode: 'manual' } });
  await engine.idle();
});

test('leads: X keeps only search-cited posts; research keeps only real paper ids', async () => {
  const board = await newBoard({ goal: 'Interaktivt ljus' });
  xCitations = ['https://x.com/a/status/1', 'https://x.com/b/status/2'];
  const { data: x } = await api('POST', `/api/boards/${board.id}/leads/x`, {});
  assert.deepEqual(x.leads.map((l: any) => l.title), ['Trend A', 'Trend B']);
  assert.equal(x.dropped, 1, 'the uncited post is dropped');
  assert.deepEqual(lastCall('leads').plugins, [{ id: 'web', engine: 'native', max_results: 12 }]);
  assert.equal(lastCall('leads').model, 'openrouter:x-ai/grok-4.3');

  const { data: r } = await api('POST', `/api/boards/${board.id}/leads/research`, {});
  assert.deepEqual(r.leads.map((l: any) => l.url), ['https://huggingface.co/papers/2610.1']);
  assert.match(lastCall('research').user, /Interaktivt ljus/);

  const { data: s } = await api('POST', `/api/leads/${x.leads[0].id}/seed`, {});
  assert.equal(s.idea.sourceUrl, 'https://x.com/a/status/1');
  assert.equal(s.lead.ideaId, s.idea.id);

  xCitations = [];
  const { data: x2 } = await api('POST', `/api/boards/${board.id}/leads/x`, {});
  assert.equal(x2.empty, true);
  assert.equal(x2.leads.length, 2, 'nothing verified: old leads stay');
  await engine.idle();
});

test('summary of a board, kept on the board and in the export', async () => {
  const board = await newBoard();
  assert.equal((await api('POST', `/api/boards/${board.id}/summary`, {})).status, 400, 'needs two ideas');
  await seed(board.id, 'Lånecyklar');
  await seed(board.id, 'Korsning');
  await engine.idle();
  const { data } = await api('POST', `/api/boards/${board.id}/summary`, {});
  assert.equal(data.board.summary.headline, 'Tavlan rör sig mot ljud.');
  assert.equal(data.board.summary.ideaCount, 2);
  const { data: md } = await api('GET', `/api/boards/${board.id}/export.md`);
  assert.match(md, /## Sammanfattning\n\nTavlan rör sig mot ljud\./);
});

test('dashboard: keyword trends across boards, and drill-down', async () => {
  judgeKeywords = ['Trend Keyword'];
  const b1 = await newBoard({ title: 'D1' });
  const b2 = await newBoard({ title: 'D2' });
  await seed(b1.id, 'Ett');
  await seed(b2.id, 'Två');
  await engine.idle();
  const { data } = await api('GET', '/api/dashboard?days=7');
  const kw = data.keywords.find((k: any) => k.keyword === 'trend keyword');
  assert.equal(kw.count, 2);
  assert.equal(kw.boards, 2);
  assert.equal(kw.recent, 2);
  assert.equal(kw.series.length, 7);
  assert.equal(kw.series.at(-1), 2, 'today');
  // A fractional period rounds to whole days and still ends today.
  const { data: half } = await api('GET', '/api/dashboard?days=1.5');
  const kwHalf = half.keywords.find((k: any) => k.keyword === 'trend keyword');
  assert.equal(kwHalf.series.length, 2);
  assert.equal(kwHalf.series.at(-1), 2, 'today is in a fractional period');
  const { data: report } = await api('GET', '/api/report?days=2.5');
  assert.equal(report.days, 3);
  assert.ok(report.totals.newIdeas >= 2, "today's ideas count as new");
  const { data: drill } = await api('GET', `/api/keywords/${encodeURIComponent('trend keyword')}/ideas`);
  assert.deepEqual(drill.ideas.map((i: any) => i.boardTitle).sort(), ['D1', 'D2']);
  judgeKeywords = ['public space', 'sound'];
});

test('DELETE /api/boards/:id: an expand still waiting on the model ends with board_deleted, not in the board that reuses the id', async () => {
  await engine.idle();
  const gone = await newBoard({ title: 'Raderas' });
  const parent = await seed(gone.id, 'Förälder');
  await engine.idle();

  let release!: () => void;
  holdChat = new Promise<void>((r) => (release = r));
  const expanding = api('POST', `/api/ideas/${parent.id}/expand`, {});
  await new Promise((r) => setTimeout(r, 20)); // the expand waits on the model

  assert.equal((await api('DELETE', `/api/boards/${gone.id}`)).status, 200);
  const next = await newBoard({ title: 'Ny' });
  assert.equal(next.id, gone.id, 'the new board gets the deleted board\'s id');

  holdChat = null;
  release();
  const r = await expanding;
  assert.equal(r.status, 409);
  assert.equal(r.data.code, 'board_deleted');
  await engine.idle();
  const { data } = await api('GET', `/api/boards/${next.id}`);
  assert.deepEqual(data.ideas, [], 'nothing from the old board\'s expand');
});

test('live events: a browser following a board sees what happens', async () => {
  const board = await newBoard();
  const ctrl = new AbortController();
  const res = await fetch(`${base}/api/boards/${board.id}/events`, { signal: ctrl.signal });
  const reader = res.body!.getReader();
  const seen: any[] = [];
  const pump = (async () => {
    let buf = '';
    const dec = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read().catch(() => ({ value: undefined, done: true }));
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        if (chunk.startsWith('data: ')) seen.push(JSON.parse(chunk.slice(6)));
      }
    }
  })();
  await seed(board.id, 'Live');
  await engine.idle();
  await new Promise((r) => setTimeout(r, 50));
  ctrl.abort();
  await pump;
  const types = seen.map((e) => e.type);
  assert.equal(types[0], 'hello');
  assert.ok(types.includes('ideas') && types.includes('judging'), types.join(','));
});

test('live events: a page open on a deleted board hears "deleted", then its stream ends', async () => {
  const board = await newBoard();
  const res = await fetch(`${base}/api/boards/${board.id}/events`);
  const reader = res.body!.getReader();
  const seen: any[] = [];
  const dec = new TextDecoder();
  const pump = (async () => {
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) return 'ended';
      buf += dec.decode(value, { stream: true });
      let cut;
      while ((cut = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        if (chunk.startsWith('data: ')) seen.push(JSON.parse(chunk.slice(6)));
      }
    }
  })();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await api('DELETE', `/api/boards/${board.id}`)).status, 200);
  const timeout = new Promise((r) => setTimeout(() => r('still open'), 2000));
  assert.equal(await Promise.race([pump, timeout]), 'ended', 'the server ends the stream');
  assert.deepEqual(seen.map((e) => e.type), ['hello', 'deleted']);
  assert.equal(seen[1].boardId, board.id);
  const next = await newBoard();
  assert.equal(next.id, board.id, 'the next board gets the id');
  await seed(next.id, 'Ny');
  await engine.idle();
  assert.deepEqual(seen.map((e) => e.type), ['hello', 'deleted'], 'nothing of the new board reached the old page');
});

test('provider failures surface with their code, and nothing is half-saved', async () => {
  const board = await newBoard();
  const s = await seed(board.id, 'Frö');
  await engine.idle();
  failNext = new ProviderError('no_key', 'OpenRouter: no API key');
  const r = await api('POST', `/api/ideas/${s.id}/expand`, {});
  assert.equal(r.status, 502);
  assert.equal(r.data.code, 'no_key');
  assert.equal(repo.listIdeas(board.id).length, 1);
});

test('links: fetched and distilled; unreadable links are an error, not a silent text seed', async () => {
  const board = await newBoard();
  const ok = await api('POST', `/api/boards/${board.id}/seed`, { text: 'https://example.com/artikel' });
  assert.equal(ok.data.idea.title, 'Destillerat frö');
  assert.equal((await api('POST', `/api/boards/${board.id}/seed`, { text: 'https://example.com/nej' })).data.code, 'url_unreadable');
  assert.equal((await api('POST', `/api/boards/${board.id}/seed`, { text: 'https://example.com/tom' })).data.code, 'url_no_text');
  await engine.idle();
  assert.equal(repo.listIdeas(board.id).length, 1);
});

test('templates: four defaults, editable, the last one stays', async () => {
  const { data } = await api('GET', '/api/templates');
  assert.equal(data.templates.length, 4);
  assert.equal((await api('POST', '/api/templates', { name: 'X' })).status, 400);
  const { data: n } = await api('POST', '/api/templates', { name: 'Ny', system: 's', expand: 'e', combine: 'c' });
  const board = await newBoard({ templateId: n.template.id });
  assert.equal(board.config.flowName, 'Ny');
  const all = (await api('GET', '/api/templates')).data.templates;
  for (const t of all.slice(0, -1)) assert.equal((await api('DELETE', `/api/templates/${t.id}`)).status, 200);
  assert.equal((await api('DELETE', `/api/templates/${all.at(-1).id}`)).data.code, 'last_template');
});

test('static files, path traversal, unknown routes', async () => {
  const res = await fetch(base + '/js/score.js');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type')!, /javascript/);
  assert.ok([403, 404].includes((await fetch(base + '/%2e%2e/package.json')).status));
  assert.equal((await api('GET', '/api/nope')).status, 404);
});

test('report: totals, every project, per-board insights, saved conclusions, Markdown', async () => {
  const { data: before } = await api('GET', '/api/report?days=30');
  assert.ok(before.totals.ideas > 0 && before.totals.boards > 0);
  assert.ok(before.projects.some((p: any) => p.title === 'Sjungande parkbänk'), 'the gold project from earlier is listed');
  assert.ok(before.boards.every((b: any) => Array.isArray(b.best) && b.best.length <= 3));
  const withSummary = before.boards.find((b: any) => b.summary);
  assert.ok(withSummary && typeof withSummary.summary.stale === 'boolean');
  assert.equal(before.synthesis, null);

  const synthCall = (r: ChatRequest) => r.schemaName === 'synthesis';
  const { data: after } = await api('POST', '/api/report/synthesis', { days: 30, lang: 'sv' });
  const call = calls.filter(synthCall).at(-1)!;
  assert.match(call.user, /Sjungande parkbänk/, 'the synthesis sees the boards’ best ideas');
  assert.match(call.user, /Claude Code projects:/);
  assert.equal(call.model, DEFAULT_APP_SETTINGS.models.summary);
  assert.equal(typeof after.synthesis.headline, 'string');
  assert.equal(after.synthesis.days, 30);

  const { data: md } = await api('GET', '/api/report.md?days=30&lang=sv');
  assert.match(md, /^# Rapport · \d{4}-\d{2}-\d{2}/);
  assert.match(md, /## Slutsatser/);
  assert.match(md, /cd ".*sjungande-bank" && claude/);
});
