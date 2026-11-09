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

type BoardState = { busy: boolean; auto: boolean; steps: number[]; lastAt: number; errors: number; lastErrorAt: number; status: AutopilotStatus; sent: string };

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
    // board ever made. Also while its step still runs: that step sees it was forgotten
    // (see mine below) and leaves no trace. The delete route forgets at once (forget());
    // this catches a board deleted some other way.
    const alive = new Set(boards.map((b) => b.id));
    for (const id of states.keys()) if (!alive.has(id)) states.delete(id);
    for (const b of boards) {
      if (b.config.mode !== 'auto') {
        // Keep the state of a board taken off auto: a step may still be running, and its
        // hour of steps and its error backoff must still count if it is switched back on.
        // Forgetting them would let a manual-auto toggle start a second step beside the
        // first, or skip the hourly limit and the backoff.
        const s = states.get(b.id);
        if (s) s.auto = false; // a step still running reads this when it ends
        if (s && !s.busy) publish(b.id, s, { state: 'manual', last: s.status.last }); // the last result stays visible
        continue;
      }
      let s = states.get(b.id);
      if (!s) {
        s = { busy: false, auto: true, steps: [], lastAt: 0, errors: 0, lastErrorAt: 0, status: { state: 'idle' }, sent: '' };
        states.set(b.id, s);
      }
      s.auto = true;
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
      // A step can outlast the board's auto mode: the user switches it to manual while
      // the step runs. Its result still counts toward the limits, but the status it shows
      // is manual, not a pace or backoff of an autopilot that is off. Every tick records
      // each board's mode in its state (st.auto), so the step reads that, not the DB.
      // Or it outlasts the board itself. Board ids are reused (INTEGER PRIMARY KEY without
      // AUTOINCREMENT): after the newest board is deleted, the next one gets its id. A
      // deleted board's state was dropped from the map, so a step whose state is no longer
      // the one kept for this id belongs to a board that is gone, and must not publish to,
      // or count toward, a new board under the same id.
      const mine = () => states.get(b.id) === st;
      engine
        .autoStep(b.id)
        .then((r) => {
          if (!mine()) return;
          if (r.did !== 'idle') st.steps.push(now());
          st.lastAt = now();
          st.errors = 0;
          const last = r.did === 'idle' ? r.reason : r.did;
          if (!st.auto) return publish(b.id, st, { state: 'manual', last });
          publish(b.id, st, {
            state: r.did === 'idle' ? 'idle' : 'pace', until: now() + b.config.autopilotSeconds * 1000,
            last, stepsLastHour: st.steps.length, spentToday: counts.spentToday,
          });
        })
        .catch((e: any) => {
          if (!mine()) return;
          st.errors++;
          st.lastErrorAt = st.lastAt = now();
          const last = st.status.last;
          if (!st.auto) return publish(b.id, st, { state: 'manual', last });
          publish(b.id, st, {
            state: 'error', code: e?.code ?? 'error', message: e?.message ?? String(e), until: now() + backoffMs(st.errors), last, ...counts,
          });
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
    /**
     * Drop a board's state now, when it is deleted. Waiting for the next tick is not
     * enough: a board created in between can get the same id and would inherit the
     * old board's hour of steps, errors, backoff and last result.
     */
    forget(boardId: number) {
      states.delete(boardId);
    },
    /**
     * A board's mode changed (the PATCH route). A step still running reads st.auto when
     * it ends; without this it would see the change only at the next tick, and show a
     * pace for an autopilot that is already off. The tick records the mode as well, so a
     * change made some other way is seen within a tick.
     */
    modeChanged(boardId: number, mode: string) {
      const s = states.get(boardId);
      if (s) s.auto = mode === 'auto';
    },
    /** Boards the scheduler currently keeps state for. */
    tracked(): number[] {
      return [...states.keys()];
    },
  };
}

export type Autopilot = ReturnType<typeof createAutopilot>;
