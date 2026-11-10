// The engine: every operation on boards and ideas, used by both the HTTP routes
// and the autopilot. New ideas are judged in the background (a small queue),
// so announced guests get judged even on boards nobody has open. Every change
// is published on a per-board bus that the browser follows over SSE.

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { Repo, Idea, Board } from './db.ts';
import { makeLLM } from './llm.ts';
import { asUrl, fetchPage as realFetchPage } from './extract.ts';
import { fetchPapers as realFetchPapers, researchLeads, xLeads } from './leads.ts';
import { writeBrief, writeProject as realWriteProject } from './project.ts';
import { ProviderError, type AppSettings, type ChatFn, type Role } from './providers.ts';
import { fitness, isJudged, medal, scoreSum } from '../public/js/score.js';
import { nextMove } from '../public/js/evolve.js';

export class AppError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export type BoardEvent = { type: string; [k: string]: unknown };
export function createBus() {
  const subs = new Map<number, Set<(e: BoardEvent) => void>>();
  return {
    on(boardId: number, fn: (e: BoardEvent) => void) {
      if (!subs.has(boardId)) subs.set(boardId, new Set());
      subs.get(boardId)!.add(fn);
      return () => subs.get(boardId)?.delete(fn);
    },
    /** Forget every listener of a board (deleted: its id can go to the next board). */
    drop(boardId: number) {
      subs.delete(boardId);
    },
    emit(boardId: number, e: BoardEvent) {
      for (const fn of subs.get(boardId) ?? []) {
        try {
          fn(e);
        } catch {
          /* a dead subscriber must not break the others */
        }
      }
    },
  };
}

type RunFile = (
  cmd: string, args: string[], options: { windowsVerbatimArguments?: boolean },
  done: (err: (Error & { code?: unknown }) | null) => void,
) => unknown;
const REVEAL_WAIT_MS = 3000;

/**
 * Show a folder in the desktop's file manager: Finder, Explorer or the freedesktop
 * default. Rejects when the opener is missing (a headless server has no xdg-open) or
 * exits with an error, so the button can say so instead of claiming success. An
 * opener still running after a few seconds has opened something and counts as done.
 * Explorer exits with 1 even when the window opened, so on Windows only a failure to
 * start it counts.
 *
 * Explorer splits its command line at commas outside quotes (they separate switches
 * like /select,), and Node quotes an argument only when it holds a space, so E:\a,b
 * opened Documents. The path goes in quotes, passed verbatim so Node does not escape
 * them. A Windows path cannot contain a quote; one that does is refused, so nothing
 * can break out of the quotes.
 */
export function revealInFileManager(path: string, platform: NodeJS.Platform = process.platform, run: RunFile = execFile as unknown as RunFile): Promise<void> {
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'explorer' : 'xdg-open';
  const [args, options] = platform === 'win32' ? [[`"${path}"`], { windowsVerbatimArguments: true }] : [[path], {}];
  if (platform === 'win32' && path.includes('"')) return Promise.reject(new Error('Cannot show the folder: its path contains a quote'));
  return new Promise((resolve, reject) => {
    const waited = setTimeout(resolve, REVEAL_WAIT_MS);
    waited.unref?.();
    run(cmd, args, options, (err) => {
      clearTimeout(waited);
      if (!err || (platform === 'win32' && typeof err.code === 'number')) return resolve();
      reject(new Error(err.code === 'ENOENT'
        ? `Cannot show the folder: ${cmd} is not installed on the server`
        : `Cannot show the folder: ${cmd} failed (${typeof err.code === 'number' ? `exit ${err.code}` : err.message})`));
    });
  });
}

/** Arc of n children pointing away from where the parent came from. */
export function arcPositions(parent: Idea, grandparent: Idea | null, n: number) {
  const dir = grandparent ? Math.atan2(parent.y - grandparent.y, parent.x - grandparent.x) : Math.random() * Math.PI * 2;
  const spread = grandparent ? (Math.PI * 2) / 3 : Math.PI * 2;
  return Array.from({ length: n }, (_, i) => {
    const a = grandparent ? dir - spread / 2 + (spread * (i + 0.5)) / n : dir + (spread * i) / n;
    return { x: parent.x + Math.cos(a) * 190, y: parent.y + Math.sin(a) * 190 };
  });
}

/** Where a newcomer (guest, lead) lands: just right of what is already on the board. */
function besideBoard(ideas: Idea[]) {
  if (!ideas.length) return { x: 0, y: 0 };
  const maxX = Math.max(...ideas.map((i) => i.x));
  const meanY = ideas.reduce((s, i) => s + i.y, 0) / ideas.length;
  return { x: maxX + 240, y: meanY + (Math.random() - 0.5) * 160 };
}

type Deps = {
  repo: Repo;
  chat: ChatFn;
  settings: () => AppSettings;
  fetchPage?: typeof realFetchPage;
  fetchPapers?: typeof realFetchPapers;
  writeProject?: typeof realWriteProject;
  reveal?: (path: string) => void | Promise<void>;
  gitInit?: boolean;
};

export function createEngine(deps: Deps) {
  const { repo } = deps;
  const fetchPage = deps.fetchPage ?? realFetchPage;
  const fetchPapers = deps.fetchPapers ?? realFetchPapers;
  const writeProject = deps.writeProject ?? realWriteProject;
  const reveal = deps.reveal ?? revealInFileManager;
  const llm = makeLLM(deps.chat);
  const bus = createBus();
  /** Ideas being judged: idea id → its board and the judgement that owns the entry. */
  const judging = new Map<number, { boardId: number; owner: symbol }>();

  const mustBoard = (id: number) => {
    const b = repo.getBoard(id);
    if (!b) throw new AppError(404, 'not_found', 'Board not found');
    return b;
  };
  const mustIdea = (id: number) => {
    const i = repo.getIdea(id);
    if (!i) throw new AppError(404, 'not_found', 'Idea not found');
    return i;
  };
  const modelFor = (board: Board, role: Role) => board.config.models[role] || deps.settings().models[role];
  const titles = (boardId: number) => repo.listIdeas(boardId).map((i) => i.title);
  const emitIdeas = (boardId: number, ideas: Idea[]) => ideas.length && bus.emit(boardId, { type: 'ideas', ideas });

  /** Every LLM call: spend lands on the board's ledger; failures become 502s that keep the provider's code. */
  // Board and idea ids can be reused. They are AUTOINCREMENT, but a database whose
  // rebuild was rolled back (addAutoincrement in db.ts) still gives the newest deleted
  // board's id to the next board created, and the same goes for ideas.
  // An operation that was waiting on the model when its board was deleted must not
  // write its result into whatever board holds that id now. Every delete of an id is
  // counted here. An operation reads the count when it starts (`since`) and passes it
  // to call(), which refuses a result that comes back after a delete; an operation that
  // also waits on something else (a page, the paper list, the disk) checks again with
  // stillThere() before it goes on. Ideas deleted on their own are counted the same way:
  // an operation on an idea (judge, expand, combine, project) watches it too.
  const deletions = new Map<number, number>();
  const ideaDeletions = new Map<number, number>();
  const deletesOf = (boardId: number) => deletions.get(boardId) ?? 0;
  const ideaDeletesOf = (ideaId: number) => ideaDeletions.get(ideaId) ?? 0;
  const boardDeleted = (what = 'the model was working') => new AppError(409, 'board_deleted', `The board was deleted while ${what}`);
  const ideaDeleted = (what = 'the model was working') => new AppError(409, 'idea_deleted', `The idea was deleted while ${what}`);
  /** board_deleted or idea_deleted: the operation's ids may be someone else's now; report nothing to them. */
  const isGone = (e: any) => e?.code === 'board_deleted' || e?.code === 'idea_deleted';

  /** What an operation depends on, with the delete counts read when it started. */
  type Watch = { boardId: number; board: number; ideas: [number, number][] };
  const watch = (boardId: number, ideaIds: number[] = []): Watch =>
    ({ boardId, board: deletesOf(boardId), ideas: ideaIds.map((id) => [id, ideaDeletesOf(id)]) });
  function goneError(w: Watch, what?: string) {
    if (deletesOf(w.boardId) !== w.board) return boardDeleted(what);
    for (const [id, n] of w.ideas) if (ideaDeletesOf(id) !== n) return ideaDeleted(what);
    return null;
  }
  /** Throws board_deleted or idea_deleted if something the operation watches was deleted since it started. */
  function stillThere(w: Watch, what?: string) {
    const e = goneError(w, what);
    if (e) throw e;
  }

  async function call<T extends { costUsd: number }>(on: number | Watch, fn: () => Promise<T>): Promise<T> {
    const w = typeof on === 'number' ? watch(on) : on;
    stillThere(w); // already gone: no model call, no cost
    let out: T;
    try {
      out = await fn();
    } catch (e: any) {
      // Failed after a delete: the error is not this id's any more (it may be another
      // board's or idea's now), so callers that skip isGone() must see that, not a 502.
      const gone = goneError(w);
      if (gone) throw gone;
      if (e instanceof AppError) throw e;
      throw new AppError(502, e instanceof ProviderError ? e.code : 'llm_failed', e?.message ?? String(e));
    }
    const gone = goneError(w);
    // The money is spent. A deleted board's goes to no board (0), so the global limit still
    // sees it and the board that now has this id is not charged; a deleted idea's board paid.
    repo.addSpend(gone?.code === 'board_deleted' ? 0 : w.boardId, out.costUsd);
    if (gone) throw gone;
    return out;
  }

  // ---------------------------------------------------------------- judging

  // Idea ids can be reused: a judgement only clears the entry it set, never one a later
  // idea with the same id set after this idea's board was deleted.
  function setJudging(boardId: number, ids: number[], on: boolean, owner: symbol, emit = true) {
    for (const id of ids) {
      if (on) judging.set(id, { boardId, owner });
      else if (judging.get(id)?.owner === owner) judging.delete(id);
    }
    if (emit) bus.emit(boardId, { type: 'judging', ids, on });
  }

  async function createProject(idea: Idea) {
    if (idea.projectPath && existsSync(idea.projectPath)) return { idea, path: idea.projectPath, existed: true };
    const board = mustBoard(idea.boardId);
    const since = watch(board.id, [idea.id]);
    const lineage = repo.lineage(idea.id);
    const lang = board.config.lang;
    const { brief } = await call(since, () => writeBrief({ chat: deps.chat, model: modelFor(board, 'brief'), idea, goal: board.goal, lineage, lang }));
    let path: string;
    try {
      path = await writeProject({ root: deps.settings().projectsRoot, brief, idea, goal: board.goal, lineage, lang, gitInit: deps.gitInit });
    } catch (e: any) {
      stillThere(since, 'its project folder was being written'); // same as a model call failing late
      throw new AppError(500, 'project_failed', e?.message ?? String(e));
    }
    // Deleted while the folder was written: the idea's id may be another board's idea
    // now, so record nothing. The folder stays (folders are never deleted here); say where.
    stillThere(since, `its project folder was being written; the folder is at ${path}`);
    const saved = repo.setProjectPath(idea.id, path)!;
    emitIdeas(board.id, [saved]);
    return { idea: saved, path, existed: false };
  }

  async function judge(ideaId: number) {
    const idea = mustIdea(ideaId);
    const board = mustBoard(idea.boardId);
    const since = watch(board.id, [idea.id]);
    const owner = Symbol('judgement');
    setJudging(board.id, [idea.id], true, owner);
    try {
      const { judgement } = await call(since, () =>
        llm.judge({
          model: modelFor(board, 'judge'), board, idea, lang: board.config.lang,
          guidance: board.config.judgeGuidance, vocabulary: repo.keywordVocabulary(),
        }),
      );
      repo.saveJudgement(idea.id, judgement);
      const out: { idea: Idea; project?: string; projectError?: string } = { idea: repo.setKeywords(idea.id, judgement.keywords)! };
      // The judge itself turns gold into a Claude Code project, if the board allows it.
      if (board.config.autoProjectOnGold && medal(out.idea) === 3 && !out.idea.projectPath) {
        try {
          const p = await createProject(out.idea);
          out.idea = p.idea;
          out.project = p.path;
          bus.emit(board.id, { type: 'project', ideaId: idea.id, path: p.path, byJudge: true });
        } catch (e: any) {
          if (isGone(e)) throw e; // not a project error: the board or the idea is gone
          out.projectError = e?.message ?? String(e);
        }
      }
      emitIdeas(board.id, [out.idea]);
      return out;
    } finally {
      // Tell the board's page the spinner is off, unless the board or idea is gone: the id may be someone else's now.
      setJudging(board.id, [idea.id], false, owner, !goneError(since));
    }
  }

  // Background queue: at most three judgements at once.
  const queue: number[] = [];
  let active = 0;
  let idleWaiters: (() => void)[] = [];
  function pump() {
    while (active < 3 && queue.length) {
      const id = queue.shift()!;
      active++;
      judge(id)
        .catch((e: any) => {
          if (isGone(e)) return; // the idea's id may belong to another idea now
          const boardId = repo.getIdea(id)?.boardId;
          if (boardId) bus.emit(boardId, { type: 'error', code: e?.code ?? 'judge_failed', message: e?.message ?? String(e), ideaId: id });
        })
        .finally(() => {
          active--;
          pump();
          if (!active && !queue.length) {
            idleWaiters.forEach((f) => f());
            idleWaiters = [];
          }
        });
    }
  }
  function queueJudge(ids: number[]) {
    for (const id of ids) if (!judging.has(id) && !queue.includes(id)) queue.push(id);
    pump();
  }
  /** Resolves when no judgement is queued or running (tests, shutdown). */
  const idle = () => (active || queue.length ? new Promise<void>((r) => idleWaiters.push(r)) : Promise.resolve());

  // ---------------------------------------------------------------- creating ideas

  async function doExpand(parentId: number) {
    const parent = mustIdea(parentId);
    const board = mustBoard(parent.boardId);
    const { ideas } = await call(watch(board.id, [parent.id]), () =>
      llm.expand({ model: modelFor(board, 'expand'), flow: board.config.flow, board, idea: parent, existingTitles: titles(board.id), lang: board.config.lang }),
    );
    const spots = arcPositions(parent, repo.parentsOf(parent.id)[0] ?? null, ideas.length);
    const created = ideas.map((i, n) =>
      repo.insertIdea({ boardId: board.id, ...i, kind: 'expand', x: spots[n].x, y: spots[n].y, generation: parent.generation + 1 }, [parent.id]),
    );
    const edges = created.map((c) => ({ from: parent.id, to: c.id }));
    emitIdeas(board.id, created);
    bus.emit(board.id, { type: 'edges', edges });
    return { ideas: created, edges };
  }

  async function doCombine(boardId: number, aId: number, bId: number) {
    const board = mustBoard(boardId);
    if (!Number.isInteger(aId) || !Number.isInteger(bId) || aId === bId) throw new AppError(400, 'bad_pair', 'Pick two different ideas');
    const a = mustIdea(aId);
    const c = mustIdea(bId);
    if (a.boardId !== board.id || c.boardId !== board.id) throw new AppError(400, 'bad_pair', 'Ideas belong to another board');
    const { idea } = await call(watch(board.id, [a.id, c.id]), () =>
      llm.combine({ model: modelFor(board, 'combine'), flow: board.config.flow, board, a, b: c, existingTitles: titles(board.id), lang: board.config.lang }),
    );
    const dx = c.x - a.x, dy = c.y - a.y, len = Math.hypot(dx, dy) || 1; // midpoint, nudged off the line
    const created = repo.insertIdea(
      {
        boardId: board.id, ...idea, kind: 'combine',
        x: (a.x + c.x) / 2 + (-dy / len) * 70, y: (a.y + c.y) / 2 + (dx / len) * 70,
        generation: Math.max(a.generation, c.generation) + 1,
      },
      [a.id, c.id],
    );
    const edges = [{ from: a.id, to: created.id }, { from: c.id, to: created.id }];
    emitIdeas(board.id, [created]);
    bus.emit(board.id, { type: 'edges', edges });
    return { idea: created, edges };
  }

  return {
    bus,
    judging,
    idle,
    queueJudge,
    modelFor,

    async seed(boardId: number, b: { text: string; x?: number; y?: number }) {
      const board = mustBoard(boardId);
      const since = watch(board.id);
      const text = String(b.text ?? '').trim().slice(0, 20_000);
      if (!text) throw new AppError(400, 'empty', 'Write an idea or paste a link');
      const lang = board.config.lang;
      const flow = board.config.flow;
      const url = asUrl(text);
      let title = text.slice(0, 120);
      let pitch = '';
      let sourceUrl: string | null = null;
      if (url) {
        let page;
        try {
          page = await fetchPage(url);
        } catch (e: any) {
          throw new AppError(422, 'url_unreadable', `${url}: ${e?.message ?? e}`);
        }
        stillThere(since, 'the link was being read');
        if (page.text.length < 80) throw new AppError(422, 'url_no_text', `${url}: too little readable text`);
        const { idea } = await call(since, () =>
          llm.distill({ model: modelFor(board, 'distill'), flow, board, text: [page.title, page.text].filter(Boolean).join('\n\n'), url, lang }),
        );
        ({ title, pitch } = idea);
        sourceUrl = url;
      } else if (text.length > 160) {
        const { idea } = await call(since, () => llm.distill({ model: modelFor(board, 'distill'), flow, board, text, lang }));
        ({ title, pitch } = idea);
      }
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
      const idea = repo.insertIdea({ boardId: board.id, title, pitch, kind: 'seed', sourceUrl, x: num(b.x), y: num(b.y), generation: 0 });
      emitIdeas(board.id, [idea]);
      queueJudge([idea.id]);
      return { idea };
    },

    async expand(ideaId: number) {
      const out = await doExpand(ideaId);
      queueJudge(out.ideas.map((i) => i.id));
      return out;
    },

    async combine(boardId: number, aId: number, bId: number) {
      const out = await doCombine(boardId, aId, bId);
      queueJudge([out.idea.id]);
      return out;
    },

    judge,
    createProject: (ideaId: number) => createProject(mustIdea(ideaId)),

    /**
     * Delete a board, and make every operation still waiting on the model for it
     * drop its result (see call()). Delete boards through here, not repo.deleteBoard:
     * the next board can get the same id.
     */
    deleteBoard(boardId: number) {
      deletions.set(boardId, deletesOf(boardId) + 1);
      // Its ideas are gone: a judgement still running for one must not make the next
      // idea that gets its id look busy (it would be skipped by the queue and the autopilot).
      for (const [id, j] of judging) if (j.boardId === boardId) judging.delete(id);
      const deleted = repo.deleteBoard(boardId);
      // Pages still open on it hear that it is gone, then stop hearing this id at all:
      // the next board created can get the same id, and its events are not theirs.
      if (deleted) bus.emit(boardId, { type: 'deleted', boardId });
      bus.drop(boardId);
      return deleted;
    },

    async reveal(ideaId: number) {
      const idea = mustIdea(ideaId);
      if (!idea.projectPath || !existsSync(idea.projectPath)) throw new AppError(404, 'no_project', 'The project folder is gone');
      try {
        await reveal(idea.projectPath);
      } catch (e: any) {
        throw new AppError(500, 'reveal_failed', e?.message ?? String(e));
      }
      return { ok: true };
    },

    setMedal(ideaId: number, m: unknown) {
      mustIdea(ideaId);
      if (m !== null && !(Number.isInteger(m) && (m as number) >= 0 && (m as number) <= 3)) {
        throw new AppError(400, 'bad_request', 'medalOverride is 0–3 or null');
      }
      const idea = repo.setMedalOverride(ideaId, m as number | null)!;
      emitIdeas(idea.boardId, [idea]);
      return { idea };
    },

    deleteIdea(ideaId: number) {
      const idea = repo.getIdea(ideaId);
      // Idea ids can be reused too: an operation still running on this idea must write
      // nothing into the next idea that gets its id (see call() and watch()).
      ideaDeletions.set(ideaId, ideaDeletesOf(ideaId) + 1);
      const ok = repo.deleteIdea(ideaId);
      if (idea) {
        // A judgement still running for it must not make the next idea with its id look busy.
        if (judging.delete(ideaId)) bus.emit(idea.boardId, { type: 'judging', ids: [ideaId], on: false });
        bus.emit(idea.boardId, { type: 'removed', ids: [ideaId] });
      }
      return { ok };
    },

    /** Announce an idea to other boards: each gets a guest copy that can cross-breed there. */
    announce(ideaId: number, boardIds: unknown) {
      const idea = mustIdea(ideaId);
      const isGuest = idea.kind === 'guest' && idea.originIdeaId;
      const originIdeaId = isGuest ? idea.originIdeaId! : idea.id;
      const originBoardId = isGuest ? idea.originBoardId : idea.boardId;
      const wanted: number[] =
        boardIds === 'all' ? repo.listBoards().map((x) => x.id) : (Array.isArray(boardIds) ? boardIds : []).filter(Number.isInteger);
      const guests: { boardId: number; idea: Idea }[] = [];
      const skipped: number[] = [];
      for (const boardId of [...new Set(wanted)]) {
        if (boardId === idea.boardId) continue;
        if (!repo.getBoard(boardId) || repo.hasGuest(boardId, originIdeaId)) {
          skipped.push(boardId);
          continue;
        }
        const at = besideBoard(repo.listIdeas(boardId));
        const guest = repo.insertIdea({
          boardId, title: idea.title, pitch: idea.pitch, kind: 'guest', sourceUrl: idea.sourceUrl,
          x: at.x, y: at.y, generation: 0, originIdeaId, originBoardId,
        });
        guests.push({ boardId, idea: guest });
        emitIdeas(boardId, [guest]);
      }
      // Judged against each target board's own goal, not the one it came from.
      queueJudge(guests.map((g) => g.idea.id));
      return { guests, skipped };
    },

    /** Spin an idea off into its own board, to refine it in its own context. */
    spinoff(ideaId: number) {
      const idea = mustIdea(ideaId);
      const parent = mustBoard(idea.boardId);
      const goal = (idea.pitch ? `${idea.title}: ${idea.pitch}` : idea.title).slice(0, 600);
      const board = repo.createBoard({ title: idea.title.slice(0, 120), goal, config: { ...parent.config, mode: 'manual' }, originIdeaId: idea.id });
      const root = repo.insertIdea({
        boardId: board.id, title: idea.title, pitch: idea.pitch, kind: 'seed', sourceUrl: idea.sourceUrl,
        x: 0, y: 0, generation: 0, originIdeaId: idea.id, originBoardId: idea.boardId,
      });
      bus.emit(parent.id, { type: 'spinoff', ideaId: idea.id, boardId: board.id, title: board.title });
      queueJudge([root.id]);
      return { board: repo.getBoard(board.id), idea: root };
    },

    updateBoard(boardId: number, patch: { title?: string; goal?: string; config?: unknown }) {
      mustBoard(boardId);
      const board = repo.updateBoard(boardId, patch)!;
      bus.emit(boardId, { type: 'board', board });
      return { board };
    },

    async summarize(boardId: number) {
      const board = mustBoard(boardId);
      const ideas = repo
        .listIdeas(board.id)
        .sort((x, y) => (fitness(y) ?? -1) - (fitness(x) ?? -1))
        .map((i) => ({ title: i.title, pitch: i.pitch, kind: i.kind, sum: scoreSum(i), reason: i.reason }));
      if (ideas.length < 2) throw new AppError(400, 'too_few', 'A summary needs at least two ideas');
      const lang = board.config.lang;
      const { summary } = await call(board.id, () => llm.summarize({ model: modelFor(board, 'summary'), board, ideas, lang }));
      const saved = repo.setSummary(board.id, { ...summary, ideaCount: ideas.length, lang, createdAt: new Date().toISOString() })!;
      bus.emit(board.id, { type: 'board', board: saved });
      return { board: saved };
    },

    /** The report's conclusions across every board, saved so the window opens instantly. */
    async synthesize(daysAsked: number, lang: 'sv' | 'en') {
      const report = repo.report(daysAsked);
      const days = report.days; // whole days: the prompt, the saved synthesis and the period agree
      const boards = report.boards.filter((b) => b.ideaCount);
      if (!boards.length) throw new AppError(400, 'too_few', 'There are no ideas to report on yet');
      const { synthesis } = await call(0, () =>
        llm.synthesize({
          model: deps.settings().models.summary, lang, days,
          boards: boards.map((b) => ({
            title: b.title, goal: b.goal, summary: b.summary?.headline ?? '',
            best: b.best.map((i) => ({ title: i.title, pitch: i.pitch, sum: i.sum })),
            projects: b.projects.map((p) => p.title),
          })),
        }),
      );
      repo.saveSynthesis(days, lang, synthesis);
      return repo.report(days);
    },

    // ---- leads: each board's own researchers
    async refreshLeads(boardId: number, source: 'x' | 'research') {
      const board = mustBoard(boardId);
      const since = watch(board.id);
      const lang = board.config.lang;
      const focus = board.config.researchers[source].focus;
      const topic = [board.goal, focus].filter(Boolean).join(' — ');
      let r: { leads: any[]; dropped?: number };
      if (source === 'x') {
        r = await call(since, () => xLeads({ chat: deps.chat, model: modelFor(board, 'x'), goal: topic, lang }));
      } else {
        let papers;
        try {
          papers = await fetchPapers(focus || board.goal);
        } catch (e: any) {
          throw new AppError(502, 'research_failed', e?.message ?? String(e));
        }
        stillThere(since, 'the papers were being fetched');
        r = await call(since, () => researchLeads({ chat: deps.chat, model: modelFor(board, 'research'), goal: topic, lang, papers }));
      }
      // Nothing verified: keep the old leads rather than wiping the panel.
      const leads = r.leads.length ? repo.replaceLeads(board.id, source, r.leads) : repo.listLeads(board.id).filter((l) => l.source === source);
      bus.emit(board.id, { type: 'leads', source, leads });
      return { leads, dropped: r.dropped ?? 0, empty: !r.leads.length };
    },

    seedLead(leadId: number, at: { x?: number; y?: number }) {
      const lead = repo.getLead(leadId);
      if (!lead) throw new AppError(404, 'not_found', 'Lead not found');
      const pos = Number.isFinite(at.x) && Number.isFinite(at.y) ? { x: at.x!, y: at.y! } : besideBoard(repo.listIdeas(lead.boardId));
      const idea = repo.insertIdea({
        boardId: lead.boardId, title: lead.title, pitch: [lead.summary, lead.hook].filter(Boolean).join(' ').slice(0, 600),
        kind: 'seed', sourceUrl: lead.url, x: pos.x, y: pos.y, generation: 0,
      });
      const used = repo.markLeadUsed(lead.id, idea.id)!;
      emitIdeas(lead.boardId, [idea]);
      bus.emit(lead.boardId, { type: 'leads', source: lead.source, leads: repo.listLeads(lead.boardId).filter((l) => l.source === lead.source) });
      queueJudge([idea.id]);
      return { idea, lead: used };
    },

    /**
     * One autopilot step: judge what is unjudged, otherwise breed (combine by
     * tournament selection) or mutate (expand a strong idea). Awaits its own
     * judgements so the next step sees the scores.
     */
    async autoStep(boardId: number): Promise<{ did: 'idle' | 'judge' | 'expand' | 'combine'; reason?: string; ids?: number[] }> {
      mustBoard(boardId);
      const ideas = repo.listIdeas(boardId);
      if (!ideas.length) return { did: 'idle', reason: 'empty' };
      const judgeAll = async (ids: number[]) => {
        const results = await Promise.allSettled(ids.map((id) => judge(id)));
        const failed = results.find((r) => r.status === 'rejected') as PromiseRejectedResult | undefined;
        if (failed && results.every((r) => r.status === 'rejected')) throw failed.reason;
      };
      const unjudged = ideas.filter((i) => !isJudged(i) && i.medalOverride == null && !judging.has(i.id)).slice(0, 3);
      if (unjudged.length) {
        await judgeAll(unjudged.map((i) => i.id));
        return { did: 'judge', ids: unjudged.map((i) => i.id) };
      }
      const move = nextMove(ideas, repo.listEdges(boardId), { busy: judging });
      if (!move) return { did: 'idle', reason: 'nothing_to_do' };
      try {
        if (move.type === 'expand') {
          const r = await doExpand(move.idea.id);
          await judgeAll(r.ideas.map((i) => i.id));
          return { did: 'expand', ids: r.ideas.map((i) => i.id) };
        }
        const r = await doCombine(boardId, move.a.id, move.b.id);
        await judgeAll([r.idea.id]);
        return { did: 'combine', ids: [r.idea.id] };
      } catch (e: any) {
        // Someone deleted the idea the step was working on: not an error worth a backoff.
        if (e?.code === 'idea_deleted') return { did: 'idle', reason: 'idea_deleted' };
        throw e;
      }
    },
  };
}

export type Engine = ReturnType<typeof createEngine>;
