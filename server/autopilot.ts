// Server-side autopilot for boards in automatic mode, with a rate limiter.
//
// Limits, checked in this order before every step:
//   1. global dollars per local day (app setting, across all boards)
//   2. the board's dollars per local day
//   3. error backoff (30 s, doubling, max 15 min)
//   4. the board's steps per hour (sliding window)
//   5. the board's pace (seconds between steps)
// Dollar limits only see providers that report cost (OpenRouter, Anthropic).
// A limit of 0 means "free models only": a board on a local model keeps running,
// while the first paid call stops it.

import type { Repo } from './db.ts';
import type { Engine } from './engine.ts';
import type { AppSettings } from './providers.ts';

export type RateInput = {
  now: number;
  steps: number[];
  lastAt: number;
  paceSeconds: number;
  stepsPerHour: number;
  boardSpent: number;
  boardUsdPerDay: number;
  globalSpent: number;
  globalUsdPerDay: number;
  errors: number;
  lastErrorAt: number;
};
export type RateDecision =
  | { ok: true }
  | { ok: false; reason: 'global_budget' | 'board_budget' | 'backoff' | 'hourly' | 'pace'; until: number };

const HOUR = 3_600_000;

export function nextLocalMidnight(now: number) {
  const d = new Date(now);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
}

export function backoffMs(errors: number) {
  return errors > 0 ? Math.min(15 * 60_000, 30_000 * 2 ** (errors - 1)) : 0;
}

/** Pure: may this board take a step now? */
export function rateCheck(i: RateInput): RateDecision {
  const overBudget = (spent: number, limit: number) => spent > 0 && spent >= limit;
  if (overBudget(i.globalSpent, i.globalUsdPerDay)) return { ok: false, reason: 'global_budget', until: nextLocalMidnight(i.now) };
  if (overBudget(i.boardSpent, i.boardUsdPerDay)) return { ok: false, reason: 'board_budget', until: nextLocalMidnight(i.now) };
  if (i.errors > 0 && i.now < i.lastErrorAt + backoffMs(i.errors)) {
    return { ok: false, reason: 'backoff', until: i.lastErrorAt + backoffMs(i.errors) };
  }
  const recent = i.steps.filter((t) => t > i.now - HOUR);
  if (recent.length >= i.stepsPerHour) return { ok: false, reason: 'hourly', until: Math.min(...recent) + HOUR };
  if (i.now < i.lastAt + i.paceSeconds * 1000) return { ok: false, reason: 'pace', until: i.lastAt + i.paceSeconds * 1000 };
  return { ok: true };
}

export type AutopilotStatus = {
  /** manual | running | idle | error | pace | hourly | backoff | board_budget | global_budget */
  state: string;
  until?: number;
  code?: string;
  message?: string;
  last?: string;
  stepsLastHour?: number;
  spentToday?: number;
};

type BoardState = { busy: boolean; steps: number[]; lastAt: number; errors: number; lastErrorAt: number; status: AutopilotStatus; sent: string };

export function createAutopilot(deps: { repo: Repo; engine: Engine; settings: () => AppSettings; now?: () => number; tickMs?: number }) {
  const { repo, engine } = deps;
  const now = deps.now ?? Date.now;
  const states = new Map<number, BoardState>();

  function publish(boardId: number, s: BoardState, status: AutopilotStatus) {
    s.status = status;
    const json = JSON.stringify(status);
    if (json === s.sent) return; // do not repeat the same status every tick
    s.sent = json;
    engine.bus.emit(boardId, { type: 'autopilot', status });
  }

  async function tick() {
    const t = now();
    const globalSpent = repo.spentOn(null);
    const boards = repo.listBoards();
    // A deleted board is gone from the list: forget its state, or the map grows with every
    // board ever made. Not while its step still runs, though: that step's result lands in it.
    const alive = new Set(boards.map((b) => b.id));
    for (const [id, s] of states) if (!alive.has(id) && !s.busy) states.delete(id);
    for (const b of boards) {
      if (b.config.mode !== 'auto') {
        // Keep the state of a board taken off auto: a step may still be running, and its
        // hour of steps and its error backoff must still count if it is switched back on.
        // Forgetting them would let a manual-auto toggle start a second step beside the
        // first, or skip the hourly limit and the backoff.
        const s = states.get(b.id);
        if (s && !s.busy) publish(b.id, s, { state: 'manual' });
        continue;
      }
      let s = states.get(b.id);
      if (!s) {
        s = { busy: false, steps: [], lastAt: 0, errors: 0, lastErrorAt: 0, status: { state: 'idle' }, sent: '' };
        states.set(b.id, s);
      }
      if (s.busy) continue;
      s.steps = s.steps.filter((x) => x > t - HOUR);
      const boardSpent = repo.spentOn(b.id);
      const counts = { stepsLastHour: s.steps.length, spentToday: Math.round(boardSpent * 10000) / 10000 };
      const d = rateCheck({
        now: t, steps: s.steps, lastAt: s.lastAt, paceSeconds: b.config.autopilotSeconds,
        stepsPerHour: b.config.rate.stepsPerHour, boardSpent, boardUsdPerDay: b.config.rate.usdPerDay,
        globalSpent, globalUsdPerDay: deps.settings().maxUsdPerDay, errors: s.errors, lastErrorAt: s.lastErrorAt,
      });
      if (!d.ok) {
        // Keep the last result visible while merely pacing.
        if (d.reason === 'pace' && (s.status.state === 'idle' || s.status.state === 'error')) continue;
        publish(b.id, s, { state: d.reason, until: d.until, last: s.status.last, ...counts });
        continue;
      }
      s.busy = true;
      publish(b.id, s, { state: 'running', last: s.status.last, ...counts });
      const st = s;
      engine
        .autoStep(b.id)
        .then((r) => {
          if (r.did !== 'idle') st.steps.push(now());
          st.lastAt = now();
          st.errors = 0;
          publish(b.id, st, {
            state: r.did === 'idle' ? 'idle' : 'pace', until: now() + b.config.autopilotSeconds * 1000,
            last: r.did === 'idle' ? r.reason : r.did, stepsLastHour: st.steps.length, spentToday: counts.spentToday,
          });
        })
        .catch((e: any) => {
          st.errors++;
          st.lastErrorAt = st.lastAt = now();
          publish(b.id, st, { state: 'error', code: e?.code ?? 'error', message: e?.message ?? String(e), until: now() + backoffMs(st.errors), ...counts });
        })
        .finally(() => {
          st.busy = false;
        });
    }
  }

  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    tick,
    start() {
      timer ??= setInterval(() => tick().catch((e) => console.error('[autopilot]', e)), deps.tickMs ?? 1000);
      return this;
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    status(boardId: number): AutopilotStatus {
      return states.get(boardId)?.status ?? { state: 'manual' };
    },
    /** Boards the scheduler currently keeps state for. */
    tracked(): number[] {
      return [...states.keys()];
    },
  };
}

export type Autopilot = ReturnType<typeof createAutopilot>;
