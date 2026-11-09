// HTTP: routes onto the engine, live events (SSE), static files.
// createHandler() takes its dependencies so the tests can run it against an
// in-memory database and a fake LLM.

import { ChatGPTError, type ChatGPT } from './chatgpt.ts';
import { localRequest } from './local-request.ts';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import type { Repo, Idea, Board } from './db.ts';
import { AppError, type Engine } from './engine.ts';
import type { Autopilot } from './autopilot.ts';
import { PROVIDERS, keySource, listModels, mergeAppSettings, type AppSettings, type ProviderId } from './providers.ts';
import { fitness, medal, scoreSum } from '../public/js/score.js';

export type Runtime = {
  get(): AppSettings;
  set(s: AppSettings): void;
  /** Has a browser pushed its settings since the server started? */
  received(): boolean;
};

type Deps = { repo: Repo; engine: Engine; autopilot: Autopilot; runtime: Runtime; publicDir: string; chatgpt?: ChatGPT };

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const daysOf = (url: URL) => Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30));

async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new AppError(413, 'too_large', 'Request body too large');
    chunks.push(c);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError(400, 'bad_json', 'Invalid JSON');
  }
}

function send(res: ServerResponse, status: number, body: unknown, type = 'application/json; charset=utf-8') {
  const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': res.getHeader('Cache-Control') ?? 'no-cache' });
  res.end(payload);
}

const LABELS = {
  sv: {
    flow: 'Flöde', ideas: 'idéer', exported: 'Exporterad', seed: 'Frö', source: 'Källa', parents: 'Föräldrar',
    originality: 'Originalitet', feasibility: 'Genomförbarhet', impact: 'Effekt', unjudged: 'Ej bedömd',
    handset: 'satt för hand', guest: 'Gäst från tavlan', project: 'Claude Code-projekt',
    summary: 'Sammanfattning', strongest: 'Starkast', gaps: 'Luckor', next: 'Nästa steg', stale: 'Sammanfattningen är äldre än tavlan',
  },
  en: {
    flow: 'Flow', ideas: 'ideas', exported: 'Exported', seed: 'Seed', source: 'Source', parents: 'Parents',
    originality: 'Originality', feasibility: 'Feasibility', impact: 'Impact', unjudged: 'Not judged',
    handset: 'set by hand', guest: 'Guest from board', project: 'Claude Code project',
    summary: 'Summary', strongest: 'Strongest', gaps: 'Gaps', next: 'Next steps', stale: 'The summary is older than the board',
  },
};
const MEDAL_ICON = ['', '🥉 ', '🥈 ', '🥇 '];

export function boardMarkdown(board: Board, ideas: Idea[], edges: { from: number; to: number }[], lang: 'sv' | 'en') {
  const L = LABELS[lang];
  const byId = new Map(ideas.map((i) => [i.id, i]));
  const parents = new Map<number, Idea[]>();
  for (const e of edges) {
    const p = byId.get(e.from);
    if (!p) continue;
    if (!parents.has(e.to)) parents.set(e.to, []);
    parents.get(e.to)!.push(p);
  }
  const sorted = [...ideas].sort((a, b) => (fitness(b) ?? -1) - (fitness(a) ?? -1) || a.id - b.id);
  const out = [`# ${board.title}`, ''];
  if (board.goal) out.push(`> ${board.goal}`, '');
  out.push(`${L.flow}: ${board.config.flowName} · ${ideas.length} ${L.ideas} · ${L.exported} ${new Date().toISOString().slice(0, 10)}`, '');
  const s = board.summary;
  if (s) {
    out.push(`## ${L.summary}`, '', s.headline, '');
    for (const t of s.themes) out.push(`**${t.name}.** ${t.insight}`, '');
    if (s.strongest.length) out.push(`**${L.strongest}:**`, ...s.strongest.map((x) => `- ${x.title}: ${x.why}`), '');
    if (s.gaps.length) out.push(`**${L.gaps}:**`, ...s.gaps.map((x) => `- ${x}`), '');
    if (s.nextSteps.length) out.push(`**${L.next}:**`, ...s.nextSteps.map((x) => `- ${x}`), '');
    if (s.ideaCount !== ideas.length) out.push(`*${L.stale} (${s.ideaCount} → ${ideas.length} ${L.ideas})*`, '');
    out.push('---', '');
  }
  for (const i of sorted) {
    const m = medal(i);
    const sum = scoreSum(i);
    out.push(`## ${m ? MEDAL_ICON[m] : ''}${i.title}${sum != null ? ` — ${sum}/15` : ''}`, '');
    if (i.pitch) out.push(i.pitch, '');
    if (sum != null) {
      out.push(`*${L.originality} ${i.originality} · ${L.feasibility} ${i.feasibility} · ${L.impact} ${i.impact}.* ${i.reason ?? ''}`.trim(), '');
    } else if (i.medalOverride == null) {
      out.push(`*${L.unjudged}*`, '');
    }
    if (i.medalOverride != null) out.push(`*${MEDAL_ICON[i.medalOverride] || '–'} ${L.handset}*`, '');
    if (i.keywords.length) out.push(i.keywords.map((k) => `\`${k}\``).join(' '), '');
    const ps = parents.get(i.id);
    if (ps?.length) out.push(`${L.parents}: ${ps.map((p) => p.title).join(' × ')}`, '');
    else if (i.kind === 'guest') out.push(`${L.guest} ${i.originBoardTitle ?? '?'}`, '');
    else if (i.sourceUrl) out.push(`${L.seed} · ${L.source}: ${i.sourceUrl}`, '');
    else out.push(`${L.seed}`, '');
    if (i.projectPath) out.push(`${L.project}: \`${i.projectPath}\``, '');
  }
  return out.join('\n');
}

const REPORT_LABELS = {
  sv: {
    title: 'Rapport', period: 'Senaste {n} dagarna', boards: 'tavlor', ideas: 'idéer', newIdeas: 'nya', projects: 'Claude Code-projekt',
    spent: 'Förbrukat', conclusions: 'Slutsatser', insights: 'Insikter', standouts: 'Mest värt att driva vidare', opportunities: 'Möjligheter',
    next: 'Nästa steg', goal: 'Mål', best: 'Bästa idéerna', summary: 'Sammanfattning', stale: 'äldre än tavlan', none: 'Inga ännu.',
    start: 'Starta',
  },
  en: {
    title: 'Report', period: 'Last {n} days', boards: 'boards', ideas: 'ideas', newIdeas: 'new', projects: 'Claude Code projects',
    spent: 'Spent', conclusions: 'Conclusions', insights: 'Insights', standouts: 'Most worth pursuing', opportunities: 'Opportunities',
    next: 'Next steps', goal: 'Goal', best: 'Best ideas', summary: 'Summary', stale: 'older than the board', none: 'None yet.',
    start: 'Start',
  },
};

export function reportMarkdown(r: ReturnType<Repo['report']>, lang: 'sv' | 'en') {
  const L = REPORT_LABELS[lang];
  const m = r.totals.medals;
  const out = [
    `# ${L.title} · ${new Date().toISOString().slice(0, 10)}`, '',
    `${L.period.replace('{n}', String(r.days))} · ${r.totals.boards} ${L.boards} · ${r.totals.ideas} ${L.ideas} (${r.totals.newIdeas} ${L.newIdeas}) · 🥇 ${m.gold} 🥈 ${m.silver} 🥉 ${m.bronze} · ${r.totals.projects} ${L.projects} · ${L.spent} $${r.totals.spentUsd.toFixed(2)}`, '',
  ];
  const s = r.synthesis;
  if (s) {
    out.push(`## ${L.conclusions}`, '', s.headline, '');
    if (s.insights?.length) out.push(`### ${L.insights}`, '', ...s.insights.map((x: string) => `- ${x}`), '');
    if (s.standouts?.length) out.push(`### ${L.standouts}`, '', ...s.standouts.map((x: any) => `- **${x.title}** (${x.board}): ${x.why}`), '');
    if (s.opportunities?.length) out.push(`### ${L.opportunities}`, '', ...s.opportunities.map((x: string) => `- ${x}`), '');
    if (s.nextSteps?.length) out.push(`### ${L.next}`, '', ...s.nextSteps.map((x: string) => `- ${x}`), '');
  }
  out.push(`## ${L.projects}`, '');
  if (!r.projects.length) out.push(L.none, '');
  for (const p of r.projects) out.push(`- **${p.title}** (${p.boardTitle}${p.sum != null ? `, ${p.sum}/15` : ''}): \`cd "${p.path}" && claude\``);
  out.push('');
  for (const b of r.boards) {
    out.push(`## ${b.title}`, '');
    if (b.goal) out.push(`> ${L.goal}: ${b.goal}`, '');
    out.push(`${b.ideaCount} ${L.ideas} (${b.newIdeas} ${L.newIdeas})`, '');
    if (b.summary) out.push(`**${L.summary}${b.summary.stale ? ` (${L.stale})` : ''}:** ${b.summary.headline}`, '');
    if (b.best.length) out.push(`**${L.best}:**`, ...b.best.map((i) => `- ${MEDAL_ICON[i.medal ?? 0]}${i.title}${i.sum != null ? ` — ${i.sum}/15` : ''}`), '');
  }
  return out.join('\n');
}

export function createHandler({ repo, engine, autopilot, runtime, publicDir, chatgpt }: Deps) {
  const root = resolve(publicDir);

  function providerStatus() {
    const s = runtime.get();
    return {
      settingsReceived: runtime.received(),
      providers: (Object.keys(PROVIDERS) as ProviderId[]).map((id) => ({
        id, label: PROVIDERS[id].label, local: !!PROVIDERS[id].local, needsKey: PROVIDERS[id].needsKey,
        search: !!PROVIDERS[id].search, note: PROVIDERS[id].note ?? null, keySource: keySource(s, id),
        baseUrl: s.baseUrls[id] ?? null,
      })),
      spentToday: repo.spentOn(null),
      spentTotal: repo.spentTotal(),
    };
  }

  type Handler = (p: string[], body: any, url: URL) => Promise<unknown> | unknown;
  const routes: [string, RegExp, Handler][] = [
    // ---- app settings: owned by the browser, held here in memory only
    ['PUT', /^\/api\/runtime-settings$/, (_p, b) => {
      runtime.set(mergeAppSettings(b));
      return providerStatus();
    }],
    ['GET', /^\/api\/providers$/, () => providerStatus()],
    ['POST', /^\/api\/providers\/([a-z]+)\/models$/, async ([id]) => {
      if (!(id in PROVIDERS)) throw new AppError(404, 'not_found', 'Unknown provider');
      try {
        return { models: await listModels(runtime.get(), id as ProviderId, chatgpt) };
      } catch (e: any) {
        throw new AppError(502, e?.code ?? 'provider_error', e?.message ?? String(e));
      }
    }],

    // ---- boards
    ['GET', /^\/api\/boards$/, () => ({ boards: repo.listBoards() })],
    ['POST', /^\/api\/boards$/, (_p, b) => {
      const lang = b.lang === 'en' ? 'en' : 'sv';
      return {
        board: repo.createBoard({
          title: str(b.title, 120) || (lang === 'en' ? 'New board' : 'Ny tavla'),
          goal: str(b.goal, 600),
          templateId: Number.isInteger(b.templateId) ? b.templateId : null,
          config: { lang },
        }),
      };
    }],
    ['GET', /^\/api\/boards\/(\d+)$/, ([id]) => {
      const board = repo.getBoard(+id);
      if (!board) throw new AppError(404, 'not_found', 'Board not found');
      const ideas = repo.listIdeas(board.id);
      return {
        board, ideas,
        edges: repo.listEdges(board.id),
        leads: repo.listLeads(board.id),
        spinoffs: repo.spinoffs(board.id),
        judging: ideas.filter((i) => engine.judging.has(i.id)).map((i) => i.id),
        autopilot: autopilot.status(board.id),
        spentToday: repo.spentOn(board.id),
      };
    }],
    ['PATCH', /^\/api\/boards\/(\d+)$/, ([id], b) => {
      const patch: any = {};
      if (typeof b.title === 'string' && b.title.trim()) patch.title = str(b.title, 120);
      if (typeof b.goal === 'string') patch.goal = str(b.goal, 600);
      if (b.config && typeof b.config === 'object') patch.config = b.config;
      return engine.updateBoard(+id, patch);
    }],
    ['DELETE', /^\/api\/boards\/(\d+)$/, ([id]) => ({ ok: repo.deleteBoard(+id) })],
    ['PUT', /^\/api\/boards\/(\d+)\/positions$/, ([id], b) => {
      if (!repo.getBoard(+id)) throw new AppError(404, 'not_found', 'Board not found');
      const positions = (Array.isArray(b.positions) ? b.positions : [])
        .filter((p: any) => Number.isInteger(p?.id) && Number.isFinite(p?.x) && Number.isFinite(p?.y))
        .map((p: any) => ({ id: p.id, x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }));
      repo.savePositions(+id, positions);
      return { ok: true, saved: positions.length };
    }],
    ['GET', /^\/api\/boards\/(\d+)\/export\.md$/, ([id], _b, url) => {
      const board = repo.getBoard(+id);
      if (!board) throw new AppError(404, 'not_found', 'Board not found');
      const lang = url.searchParams.get('lang') === 'en' ? 'en' : 'sv';
      return { __raw: boardMarkdown(board, repo.listIdeas(board.id), repo.listEdges(board.id), lang), type: 'text/markdown; charset=utf-8' };
    }],
    ['POST', /^\/api\/boards\/(\d+)\/summary$/, ([id]) => engine.summarize(+id)],

    // ---- ideas
    ['POST', /^\/api\/boards\/(\d+)\/seed$/, ([id], b) => engine.seed(+id, b)],
    ['POST', /^\/api\/ideas\/(\d+)\/expand$/, ([id]) => engine.expand(+id)],
    ['POST', /^\/api\/boards\/(\d+)\/combine$/, ([id], b) => engine.combine(+id, b.a, b.b)],
    ['POST', /^\/api\/ideas\/(\d+)\/judge$/, ([id]) => engine.judge(+id)],
    ['PATCH', /^\/api\/ideas\/(\d+)$/, ([id], b) => {
      if (!('medalOverride' in b)) throw new AppError(400, 'bad_request', 'Nothing to change');
      return engine.setMedal(+id, b.medalOverride);
    }],
    ['DELETE', /^\/api\/ideas\/(\d+)$/, ([id]) => engine.deleteIdea(+id)],
    ['POST', /^\/api\/ideas\/(\d+)\/project$/, ([id]) => engine.createProject(+id)],
    ['POST', /^\/api\/ideas\/(\d+)\/reveal$/, ([id]) => engine.reveal(+id)],
    ['POST', /^\/api\/ideas\/(\d+)\/announce$/, ([id], b) => engine.announce(+id, b.boardIds)],
    ['POST', /^\/api\/ideas\/(\d+)\/spinoff$/, ([id]) => engine.spinoff(+id)],

    // ---- leads
    ['POST', /^\/api\/boards\/(\d+)\/leads\/(x|research)$/, ([id, source]) => engine.refreshLeads(+id, source as 'x' | 'research')],
    ['POST', /^\/api\/leads\/(\d+)\/seed$/, ([id], b) => engine.seedLead(+id, b)],
    ['DELETE', /^\/api\/leads\/(\d+)$/, ([id]) => ({ ok: repo.deleteLead(+id) })],

    // ---- dashboard: keyword trends across all boards
    ['GET', /^\/api\/dashboard$/, (_p, _b, url) => repo.dashboard(Math.min(365, Math.max(1, Number(url.searchParams.get('days')) || 30)))],
    ['GET', /^\/api\/keywords\/([^/]+)\/ideas$/, ([kw]) => ({ ideas: repo.ideasWithKeyword(decodeURIComponent(kw)) })],

    // ---- report: insights, ideas and projects across all boards
    ['GET', /^\/api\/report$/, (_p, _b, url) => repo.report(daysOf(url))],
    ['POST', /^\/api\/report\/synthesis$/, (_p, b) => engine.synthesize(Math.min(365, Math.max(1, Number(b.days) || 30)), b.lang === 'en' ? 'en' : 'sv')],
    ['GET', /^\/api\/report\.md$/, (_p, _b, url) => ({
      __raw: reportMarkdown(repo.report(daysOf(url)), url.searchParams.get('lang') === 'en' ? 'en' : 'sv'),
      type: 'text/markdown; charset=utf-8',
    })],

    // ---- flow templates
    ['GET', /^\/api\/templates$/, () => ({ templates: repo.listTemplates() })],
    ['POST', /^\/api\/templates$/, (_p, b) => ({ template: repo.createTemplate(templateBody(b)) })],
    ['PUT', /^\/api\/templates\/(\d+)$/, ([id], b) => ({ template: repo.updateTemplate(+id, templateBody(b)) })],
    ['DELETE', /^\/api\/templates\/(\d+)$/, ([id]) => {
      if (!repo.deleteTemplate(+id)) throw new AppError(400, 'last_template', 'The last template cannot be deleted');
      return { ok: true };
    }],
  ];

  function templateBody(b: any) {
    const t = { name: str(b.name, 80), system: str(b.system, 4000), expand: str(b.expand, 4000), combine: str(b.combine, 4000) };
    if (!t.name || !t.system || !t.expand || !t.combine) throw new AppError(400, 'bad_request', 'A template needs a name and all three prompts');
    return t;
  }

  /** Server-sent events: everything that happens on one board, live. */
  function events(boardId: number, req: IncomingMessage, res: ServerResponse) {
    if (!repo.getBoard(boardId)) return send(res, 404, { error: 'Board not found' });
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': res.getHeader('Cache-Control') ?? 'no-cache', Connection: 'keep-alive' });
    const write = (e: unknown) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    write({ type: 'hello', autopilot: autopilot.status(boardId), settingsReceived: runtime.received() });
    const off = engine.bus.on(boardId, write);
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => {
      off();
      clearInterval(ping);
    });
  }

  async function serveStatic(pathname: string, res: ServerResponse) {
    const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = resolve(join(root, rel));
    if (file !== root && !file.startsWith(root + sep)) return send(res, 403, { error: 'Forbidden' });
    try {
      const data = await readFile(file);
      send(res, 200, data, TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream');
    } catch {
      send(res, 404, { error: 'Not found' });
    }
  }

  return async function handler(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      // The browser retains cross-site fetch metadata through the callback's redirect.
      // This static confirmation document exposes no account data or credential actions.
      const publicNavigation = url.pathname === '/' || url.pathname === '/auth/chatgpt/done';
      if (!localRequest(req, url.pathname === '/auth/callback', publicNavigation)) return send(res, 403, { error: 'Only same-origin loopback requests are allowed' });
      if (url.pathname.startsWith('/auth/') || url.pathname.startsWith('/api/chatgpt')) {
        res.setHeader('Cache-Control', 'no-store');
        res.setHeader('Referrer-Policy', 'no-referrer');
        if (!chatgpt) throw new ChatGPTError('chatgpt_disabled', 'ChatGPT requires the local 127.0.0.1 server');
        if (url.pathname === '/auth/chatgpt/authorize' && req.method === 'GET') {
          const out = chatgpt.authorize(url.searchParams.get('id') ?? '');
          res.writeHead(302, { Location: out.url, 'Set-Cookie': `ideagen_oauth=${out.cookie}; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=600` });
          return res.end();
        }
        if (url.pathname === '/auth/callback' && req.method === 'GET') {
          const cookie = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith('ideagen_oauth='))?.slice(14) ?? '';
          try { await chatgpt.callback(url.searchParams, cookie); } catch { /* Details remain in safe status, never callback URLs or logs. */ }
          res.writeHead(303, { Location: '/auth/chatgpt/done', 'Set-Cookie': 'ideagen_oauth=; HttpOnly; SameSite=Lax; Path=/auth; Max-Age=0' });
          return res.end();
        }
        if (url.pathname === '/auth/chatgpt/done' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
          return res.end('ChatGPT sign-in attempt finished. Return to Idea Generator Settings to check the result. You can close this tab.');
        }
        let out: unknown;
        if (url.pathname === '/api/chatgpt/status' && req.method === 'GET') out = chatgpt.status();
        else if (req.method === 'POST') {
          const b = await readJson(req);
          if (url.pathname === '/api/chatgpt/start') out = chatgpt.begin(`http://${req.headers.host}`, b.accountId, b.consent === true);
          else if (url.pathname === '/api/chatgpt/cancel') { chatgpt.cancelAttempt(b.attemptId); out = {}; }
          else if (url.pathname === '/api/chatgpt/select') { chatgpt.select(b.accountId); out = {}; }
          else if (url.pathname === '/api/chatgpt/signout') out = await chatgpt.signOut(b.accountId);
          else if (url.pathname === '/api/chatgpt/models') out = { models: await chatgpt.models() };
          else if (url.pathname === '/api/chatgpt/welcome') { chatgpt.acknowledge(); out = {}; }
          else if (url.pathname === '/api/chatgpt/resume') { chatgpt.resume(); out = {}; }
        }
        if (out === undefined) throw new AppError(404, 'not_found', 'Unknown ChatGPT route');
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        return res.end(JSON.stringify(out));
      }
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'Method not allowed' });
        return await serveStatic(url.pathname, res);
      }
      const ev = url.pathname.match(/^\/api\/boards\/(\d+)\/events$/);
      if (ev && req.method === 'GET') return events(+ev[1], req, res);
      for (const [method, re, fn] of routes) {
        const m = url.pathname.match(re);
        if (!m || method !== req.method) continue;
        const body = method === 'GET' || method === 'DELETE' ? {} : await readJson(req);
        const out: any = await fn(m.slice(1), body, url);
        if (out?.__raw !== undefined) return send(res, 200, out.__raw, out.type);
        return send(res, 200, out);
      }
      throw new AppError(404, 'not_found', `No route for ${req.method} ${url.pathname}`);
    } catch (e: any) {
      const status = e instanceof AppError ? e.status : e instanceof ChatGPTError ? 400 : 500;
      if (status >= 500) console.error(`[${req.method} ${url.pathname}]`, e?.message ?? e);
      send(res, status, { error: e?.message ?? 'Server error', code: e?.code ?? 'server_error' });
    }
  };
}
