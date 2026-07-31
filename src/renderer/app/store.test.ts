import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Action } from './actions';
import type { Effect } from './effects';
import type { Reduction } from './reducer/combine';
import { initialFocusState, initialLayoutState, initialOverlayState } from './chrome';
import { initialRepositoryState } from './repository';
import { initialViewerState } from './viewer';
import { createStore, type Dispatch } from './store';
import type { AppState } from './state';
import { initialSettingsState } from './settings';

/**
 * The store's three guarantees, each of which the reducer alone cannot provide:
 * one notification per burst, effects strictly after the commit, and re-entrant
 * dispatch queued rather than recursed.
 */

const stateWith = (nextId: number): AppState => ({
  workspace: { status: 'empty' },
  repository: initialRepositoryState,
  viewer: initialViewerState,
  terminals: { panes: [], activePaneId: null, nextPaneSeq: 1 },
  layout: initialLayoutState,
  focus: initialFocusState,
  overlays: initialOverlayState,
  settings: initialSettingsState,
  notices: { items: [], nextId },
});

const base = stateWith(1);

const raise = (message: string): Action => ({
  type: 'notice/raised',
  severity: 'info',
  message,
});

/** Counts every action, so each dispatch produces a distinct state object. */
const countingReduce = (state: AppState, _action: Action): Reduction<AppState> => ({
  state: stateWith(state.notices.nextId + 1),
  effects: [],
});

const inertReduce = (state: AppState): Reduction<AppState> => ({ state, effects: [] });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('notification', () => {
  it('notifies once for a burst dispatched from a single listener callback', () => {
    const store = createStore({ initialState: base, reduce: countingReduce });
    let notifications = 0;
    let armed = true;

    store.subscribe(() => {
      notifications += 1;
      if (armed) {
        armed = false;
        // Re-entrant: dispatched while the notification is being delivered.
        store.dispatch(raise('b'));
        store.dispatch(raise('c'));
      }
    });

    store.dispatch(raise('a'));

    // Two notifications: one for the original action, one for the pair the
    // listener queued — which are reduced together because notification happens
    // with the drain still open. Not three.
    expect(notifications).toBe(2);
  });

  it('throws rather than hanging when a subscriber dispatches unconditionally', () => {
    const store = createStore({ initialState: base, reduce: countingReduce });
    store.subscribe(() => {
      store.dispatch(raise('again'));
    });

    // A wedged renderer gives no clue where the loop is; an exception names it.
    expect(() => store.dispatch(raise('start'))).toThrow(/did not settle/);
  });

  it('does not notify when state is referentially unchanged', () => {
    const store = createStore({ initialState: base, reduce: inertReduce });
    const listener = vi.fn();
    store.subscribe(listener);

    store.dispatch(raise('a'));

    expect(listener).not.toHaveBeenCalled();
  });

  it('stops notifying after unsubscribe', () => {
    const store = createStore({ initialState: base, reduce: countingReduce });
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    store.dispatch(raise('a'));
    unsubscribe();
    store.dispatch(raise('b'));

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('survives a listener unsubscribing itself mid-notification', () => {
    const store = createStore({ initialState: base, reduce: countingReduce });
    const second = vi.fn();

    const unsubscribeFirst = store.subscribe(() => {
      unsubscribeFirst();
    });
    store.subscribe(second);

    store.dispatch(raise('a'));

    // Mutating the listener set during iteration must not skip its neighbour.
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('action ordering', () => {
  it('drains a re-entrant dispatch in order rather than recursing', () => {
    const seen: string[] = [];
    const store = createStore({
      initialState: base,
      reduce: countingReduce,
      onAction: (action) => {
        if (action.type === 'notice/raised') {
          seen.push(action.message);
        }
      },
      runEffect: () => {},
    });

    let armed = true;
    store.subscribe(() => {
      if (armed) {
        armed = false;
        store.dispatch(raise('inner'));
      }
    });

    store.dispatch(raise('outer'));

    expect(seen).toEqual(['outer', 'inner']);
  });
});

describe('effects', () => {
  const pick: Effect = { type: 'workspace/pickFolder' };

  it('runs effects after the commit, so an effect observes the new state', () => {
    const observed: number[] = [];
    const store = createStore({
      initialState: base,
      reduce: (state, action) =>
        action.type === 'notice/raised'
          ? { state: stateWith(99), effects: [pick] }
          : { state, effects: [] },
      runEffect: () => {
        observed.push(store.getState().notices.nextId);
      },
    });

    store.dispatch(raise('a'));

    expect(observed).toEqual([99]);
  });

  it('notifies subscribers before running effects', () => {
    const order: string[] = [];
    const store = createStore({
      initialState: base,
      reduce: (state, action) =>
        action.type === 'notice/raised'
          ? { state: stateWith(state.notices.nextId + 1), effects: [pick] }
          : { state, effects: [] },
      runEffect: () => {
        order.push('effect');
      },
    });
    store.subscribe(() => {
      order.push('notify');
    });

    store.dispatch(raise('a'));

    expect(order).toEqual(['notify', 'effect']);
  });

  it('collects effects from every action in a burst', () => {
    const run: Effect[] = [];
    const store = createStore({
      initialState: base,
      reduce: (state) => ({ state: stateWith(state.notices.nextId + 1), effects: [pick] }),
      runEffect: (effect) => {
        run.push(effect);
      },
    });

    let armed = true;
    store.subscribe(() => {
      if (armed) {
        armed = false;
        store.dispatch(raise('inner'));
      }
    });

    store.dispatch(raise('outer'));

    expect(run).toHaveLength(2);
  });

  it('lets an effect dispatch, which drains as a new burst', () => {
    const store = createStore({
      initialState: base,
      reduce: (state, action) =>
        action.type === 'notice/raised' && action.message === 'first'
          ? { state: stateWith(2), effects: [pick] }
          : { state: stateWith(state.notices.nextId + 1), effects: [] },
      runEffect: (_effect, dispatch: Dispatch) => {
        dispatch(raise('from-effect'));
      },
    });

    store.dispatch(raise('first'));

    expect(store.getState().notices.nextId).toBe(3);
  });
});

describe('failure containment', () => {
  it('does not wedge the store when a reducer throws', () => {
    let shouldThrow = true;
    const store = createStore({
      initialState: base,
      reduce: (state) => {
        if (shouldThrow) {
          throw new Error('reducer exploded');
        }
        return { state: stateWith(state.notices.nextId + 1), effects: [] };
      },
    });

    expect(() => store.dispatch(raise('bad'))).toThrow('reducer exploded');

    // A store stuck with `draining === true` would swallow every later dispatch
    // silently, which is far worse than the original throw.
    shouldThrow = false;
    store.dispatch(raise('good'));

    expect(store.getState().notices.nextId).toBe(2);
  });
});

describe('getState', () => {
  it('returns the current state, not a copy', () => {
    const store = createStore({ initialState: base, reduce: inertReduce });

    expect(store.getState()).toBe(base);
  });
});
