import { describe, expect, it } from 'vitest';
import type { Action } from '../actions';
import type { Effect } from '../effects';
import { changed, combineSlices, idle, withEffects, type SliceReducer } from './combine';

/**
 * `combineSlices` is the load-bearing piece of the state model: if identity
 * preservation breaks, every terminal chunk re-renders the workspace, and if
 * effect order is not deterministic, no effect sequence can be asserted.
 */

interface TestState {
  readonly left: { readonly n: number };
  readonly right: { readonly n: number };
}

const openRequested: Action = { type: 'workspace/openRequested' };
const closeRequested: Action = { type: 'workspace/closeRequested' };

const pick: Effect = { type: 'workspace/pickFolder' };
const close: Effect = { type: 'workspace/close', sessionId: 1 };

const inert: SliceReducer<{ readonly n: number }> = (state) => idle(state);

const bumpOn =
  (trigger: Action['type']): SliceReducer<{ readonly n: number }> =>
  (state, action) =>
    action.type === trigger ? changed({ n: state.n + 1 }) : idle(state);

const initial: TestState = { left: { n: 0 }, right: { n: 0 } };

describe('identity preservation', () => {
  it('returns the very same state object when no slice changed', () => {
    const reduce = combineSlices<TestState>({ left: inert, right: inert });

    const result = reduce(initial, openRequested);

    // Not `toEqual`: an equal-but-new object would defeat useSyncExternalStore
    // and React.memo, which is the entire reason this matters.
    expect(result.state).toBe(initial);
  });

  it('preserves untouched slices by identity when a sibling changes', () => {
    const reduce = combineSlices<TestState>({
      left: bumpOn('workspace/openRequested'),
      right: inert,
    });

    const result = reduce(initial, openRequested);

    expect(result.state).not.toBe(initial);
    expect(result.state.left).not.toBe(initial.left);
    expect(result.state.right).toBe(initial.right);
  });

  it('stays stable across repeated unrelated actions', () => {
    const reduce = combineSlices<TestState>({
      left: bumpOn('workspace/openRequested'),
      right: inert,
    });

    const first = reduce(initial, closeRequested);
    const second = reduce(first.state, closeRequested);

    expect(first.state).toBe(initial);
    expect(second.state).toBe(initial);
  });
});

describe('effect collection', () => {
  it("orders effects by slice key, then by the slice's own order", () => {
    const reduce = combineSlices<TestState>({
      left: (state) => withEffects(state, pick),
      right: (state) => withEffects(state, close, pick),
    });

    const result = reduce(initial, openRequested);

    expect(result.effects).toEqual([pick, close, pick]);
  });

  it('is deterministic across calls', () => {
    const reduce = combineSlices<TestState>({
      left: (state) => withEffects(state, pick),
      right: (state) => withEffects(state, close),
    });

    const a = reduce(initial, openRequested);
    const b = reduce(initial, openRequested);

    expect(a.effects).toEqual(b.effects);
  });

  it('returns an empty list, not undefined, when no slice asked for work', () => {
    const reduce = combineSlices<TestState>({ left: inert, right: inert });

    expect(reduce(initial, openRequested).effects).toEqual([]);
  });

  it("does not deduplicate — that is the root reducer's job", () => {
    const reduce = combineSlices<TestState>({
      left: (state) => withEffects(state, pick),
      right: (state) => withEffects(state, pick),
    });

    expect(reduce(initial, openRequested).effects).toHaveLength(2);
  });

  it('collects effects even from a slice that did not change state', () => {
    const reduce = combineSlices<TestState>({
      left: (state) => withEffects(state, pick),
      right: inert,
    });

    const result = reduce(initial, openRequested);

    expect(result.state).toBe(initial);
    expect(result.effects).toEqual([pick]);
  });
});

describe('slice isolation', () => {
  it('passes each slice only its own state', () => {
    const seen: unknown[] = [];
    const reduce = combineSlices<TestState>({
      left: (state) => {
        seen.push(state);
        return idle(state);
      },
      right: (state) => {
        seen.push(state);
        return idle(state);
      },
    });

    reduce(initial, openRequested);

    expect(seen).toEqual([initial.left, initial.right]);
  });

  it('lets several slices react to one action without coordinating', () => {
    // This is how invariant 10 ("panels communicate only through actions and
    // shared state") is satisfied without a mediator.
    const reduce = combineSlices<TestState>({
      left: bumpOn('workspace/closeRequested'),
      right: bumpOn('workspace/closeRequested'),
    });

    const result = reduce(initial, closeRequested);

    expect(result.state.left.n).toBe(1);
    expect(result.state.right.n).toBe(1);
  });
});
