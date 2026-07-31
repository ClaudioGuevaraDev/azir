import type { Action } from '../actions';
import type { Effect } from '../effects';

/**
 * Slice composition — the mechanism the whole state model rests on.
 *
 * docs/architecture.md defines `reduce(AppState, Action) -> { state, effects }`.
 * Splitting that by domain gives sub-reducers with the same signature, which are
 * then composed here. Two properties are guaranteed and are what the tests pin
 * down:
 *
 *  1. **Identity is preserved when nothing changed.** A slice that returns the
 *     same object leaves `AppState` referentially unchanged too, so React's
 *     memoisation and `useSyncExternalStore` do not see a spurious update. Losing
 *     this turns every keystroke into a full workspace re-render.
 *  2. **Effect order is deterministic** — key insertion order of the reducer map,
 *     then per-slice order. Without a defined order, an effect sequence is
 *     untestable and behaviour differs between builds.
 *
 * Note what composition also buys: cross-slice reactions need no coordination.
 * When `workspace/closed` is dispatched, every slice handles it independently,
 * which is how "panels never call each other directly" (invariant 10) is
 * achievable without a mediator.
 */

export interface Reduction<S> {
  readonly state: S;
  readonly effects: readonly Effect[];
}

export type SliceReducer<S> = (state: S, action: Action) => Reduction<S>;

export type SliceReducers<S> = {
  readonly [K in keyof S]: SliceReducer<S[K]>;
};

/** No state change, no work requested. The common case. */
export const idle = <S>(state: S): Reduction<S> => ({ state, effects: EMPTY });

/** State changed, no work requested. */
export const changed = <S>(state: S): Reduction<S> => ({ state, effects: EMPTY });

/** State (possibly unchanged) plus work to perform. */
export const withEffects = <S>(state: S, ...effects: Effect[]): Reduction<S> => ({
  state,
  effects,
});

/** Shared so the overwhelmingly common "no effects" case allocates nothing. */
const EMPTY: readonly Effect[] = Object.freeze([]);

export const combineSlices = <S extends object>(reducers: SliceReducers<S>): SliceReducer<S> => {
  const keys = Object.keys(reducers) as (keyof S)[];

  return (state, action) => {
    let anyChanged = false;
    let effects: Effect[] | undefined;
    const next = {} as S;

    for (const key of keys) {
      const reducer = reducers[key];
      const result = reducer(state[key], action);

      next[key] = result.state;
      if (result.state !== state[key]) {
        anyChanged = true;
      }
      if (result.effects.length > 0) {
        effects ??= [];
        effects.push(...result.effects);
      }
    }

    return {
      // Returning the original object rather than an equal copy is the whole
      // point — see property 1 above.
      state: anyChanged ? next : state,
      effects: effects ?? EMPTY,
    };
  };
};
