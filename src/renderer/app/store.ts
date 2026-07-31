import type { Unsubscribe } from '@shared/bridge';
import type { Action } from './actions';
import type { Effect } from './effects';
import type { Reduction } from './reducer/combine';
import { reduce as defaultReduce } from './reducer';
import { initialState, type AppState } from './state';

export type Dispatch = (action: Action) => void;

/** Interprets one effect. Async, and never throws — failures come back as actions. */
export type EffectRunner = (effect: Effect, dispatch: Dispatch) => void;

export interface Store {
  getState(): AppState;
  dispatch: Dispatch;
  subscribe(listener: () => void): Unsubscribe;
}

export interface StoreOptions {
  readonly initialState?: AppState;
  readonly reduce?: (state: AppState, action: Action) => Reduction<AppState>;
  readonly runEffect?: EffectRunner;
  /** Called for each action before reducing. Used by tests and dev logging. */
  readonly onAction?: (action: Action, state: AppState) => void;
}

/**
 * Guards against a subscriber that dispatches unconditionally. A renderer stuck
 * in an infinite drain is unrecoverable and gives no clue where it went wrong; a
 * thrown error names the problem.
 */
const MAX_DRAIN_ROUNDS = 100;

/**
 * The store enforces three things the reducer alone cannot.
 *
 * **State is committed before anyone is told, and effects run after everyone
 * has been.** An effect that dispatches synchronously must observe the state its
 * own action produced, so effects cannot run mid-drain.
 *
 * **A subscriber that reacts by dispatching costs one extra notification, not
 * one per action.** Notification happens with the drain still open, so actions a
 * subscriber dispatches are queued and reduced together in the next round. This
 * is why the loop is two levels: the inner one reduces everything queued, the
 * outer one exists because notifying can queue more.
 *
 * **A re-entrant dispatch queues instead of recursing.** Recursion would produce
 * an interleaved, order-dependent state sequence; queueing gives a total order.
 * The `finally` also clears the flag when a reducer throws, because a store stuck
 * with `draining === true` would silently swallow every later dispatch — much
 * worse than the original exception.
 *
 * Deliberately *not* done here: coalescing separate dispatches from the same
 * event handler into one notification. That needs a microtask, which reintroduces
 * tearing risk, and React already batches renders from `useSyncExternalStore`.
 * The re-render guard that matters is upstream — slice reducers preserve identity,
 * so an action that changes nothing notifies nobody.
 */
export const createStore = (options: StoreOptions = {}): Store => {
  const reduce = options.reduce ?? defaultReduce;
  const runEffect = options.runEffect;
  const onAction = options.onAction;

  let state = options.initialState ?? initialState;
  const listeners = new Set<() => void>();

  const queue: Action[] = [];
  let draining = false;

  const notify = (): void => {
    // Copied because a listener may unsubscribe itself, and mutating the set
    // during iteration would skip its neighbour.
    for (const listener of [...listeners]) {
      listener();
    }
  };

  const dispatch: Dispatch = (action) => {
    queue.push(action);

    if (draining) {
      return;
    }

    draining = true;
    const pending: Effect[] = [];
    let lastNotified = state;
    let rounds = 0;

    try {
      while (queue.length > 0) {
        rounds += 1;
        if (rounds > MAX_DRAIN_ROUNDS) {
          throw new Error(
            'store: dispatch did not settle after ' +
              `${MAX_DRAIN_ROUNDS} rounds — a subscriber is dispatching in a loop`,
          );
        }

        while (queue.length > 0) {
          const next = queue.shift();
          if (next === undefined) {
            break;
          }
          onAction?.(next, state);
          const result = reduce(state, next);
          state = result.state;
          if (result.effects.length > 0) {
            pending.push(...result.effects);
          }
        }

        // Still inside the drain: anything a subscriber dispatches from here is
        // queued and handled by the next round rather than starting its own.
        if (state !== lastNotified) {
          lastNotified = state;
          notify();
        }
      }
    } finally {
      draining = false;
      queue.length = 0;
    }

    if (runEffect) {
      for (const effect of pending) {
        runEffect(effect, dispatch);
      }
    }
  };

  return {
    getState: () => state,
    dispatch,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};
