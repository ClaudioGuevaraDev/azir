import { describe, expect, it } from 'vitest';
import type { Action } from '../actions';
import type { NoticesState } from '../state';
import { noticesReducer } from './notices';

const empty: NoticesState = { items: [], nextId: 1 };

const raise = (message: string, detail?: string): Action =>
  detail === undefined
    ? { type: 'notice/raised', severity: 'error', message }
    : { type: 'notice/raised', severity: 'error', message, detail };

const run = (state: NoticesState, ...actions: Action[]): NoticesState =>
  actions.reduce((current, action) => noticesReducer(current, action).state, state);

describe('raising', () => {
  it('adds a notice with an id minted from state, keeping the reducer pure', () => {
    const result = run(empty, raise('git is not installed'));

    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.id).toBe('n1');
    expect(result.nextId).toBe(2);
  });

  it('is deterministic: the same input produces the same ids', () => {
    const a = run(empty, raise('one'), raise('two'));
    const b = run(empty, raise('one'), raise('two'));

    expect(a).toEqual(b);
  });

  it('orders newest first, because that is the failure the user is reacting to', () => {
    const result = run(empty, raise('older'), raise('newer'));

    expect(result.items.map((notice) => notice.message)).toEqual(['newer', 'older']);
  });

  it('omits `detail` entirely when none was given', () => {
    const result = run(empty, raise('no detail'));

    expect('detail' in (result.items[0] ?? {})).toBe(false);
  });

  it('keeps `detail` when given', () => {
    const result = run(empty, raise('with detail', 'ENOENT'));

    expect(result.items[0]?.detail).toBe('ENOENT');
  });

  it('is bounded, so a failure storm cannot grow state without limit', () => {
    const storm = Array.from({ length: 200 }, (_, index) => raise(`failure ${index}`));

    const result = run(empty, ...storm);

    expect(result.items.length).toBeLessThanOrEqual(24);
    // The newest survive; the oldest are dropped.
    expect(result.items[0]?.message).toBe('failure 199');
  });

  it('keeps minting fresh ids after eviction, so no two notices ever share one', () => {
    const storm = Array.from({ length: 40 }, (_, index) => raise(`failure ${index}`));

    const result = run(empty, ...storm);

    expect(new Set(result.items.map((notice) => notice.id)).size).toBe(result.items.length);
  });
});

describe('dismissing', () => {
  it('removes the named notice', () => {
    const withTwo = run(empty, raise('one'), raise('two'));

    const result = run(withTwo, { type: 'notice/dismissed', id: 'n1' });

    expect(result.items.map((notice) => notice.id)).toEqual(['n2']);
  });

  it('preserves identity when the id is unknown, so no re-render is triggered', () => {
    const withOne = run(empty, raise('one'));

    const result = noticesReducer(withOne, { type: 'notice/dismissed', id: 'nope' });

    expect(result.state).toBe(withOne);
  });

  it('does not reuse the dismissed id', () => {
    const withOne = run(empty, raise('one'));
    const dismissed = run(withOne, { type: 'notice/dismissed', id: 'n1' });

    const result = run(dismissed, raise('two'));

    expect(result.items[0]?.id).toBe('n2');
  });
});

describe('workspace scope', () => {
  it('clears notices when the workspace closes', () => {
    // "Cannot read src/index.ts" makes no sense once a different folder is open.
    const withTwo = run(empty, raise('one'), raise('two'));

    const result = run(withTwo, { type: 'workspace/closed', sessionId: 1 });

    expect(result.items).toEqual([]);
  });

  it('preserves identity when there was nothing to clear', () => {
    const result = noticesReducer(empty, { type: 'workspace/closed', sessionId: 1 });

    expect(result.state).toBe(empty);
  });

  it('keeps the id counter across a workspace change', () => {
    const withOne = run(empty, raise('one'));

    const result = run(withOne, { type: 'workspace/closed', sessionId: 1 }, raise('two'));

    expect(result.items[0]?.id).toBe('n2');
  });
});

describe('unrelated actions', () => {
  it('never allocates', () => {
    const result = noticesReducer(empty, { type: 'workspace/openRequested' });

    expect(result.state).toBe(empty);
    expect(result.effects).toEqual([]);
  });
});
