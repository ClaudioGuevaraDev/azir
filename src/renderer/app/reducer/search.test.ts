import { describe, expect, it } from 'vitest';
import type { ContentSearchResponse, WorkspaceInfo } from '@shared/ipc/contracts';
import type { Action } from '../actions';
import { initialState, type AppState } from '../state';
import { reduce } from './index';

/**
 * Search, through the root reducer.
 *
 * Two claims from docs/architecture.md are asserted here and nowhere else:
 *
 *  - "Path search operates on an in-memory path index and should respond on every keystroke
 *    without IPC." Enforced negatively: typing in path mode must emit no effect at all.
 *  - "The reducer drops results for a query that is no longer current. Latest query wins."
 */

const INFO: WorkspaceInfo = { sessionId: 1, root: '/w', name: 'w' };

/**
 * A genuinely open workspace.
 *
 * All three steps are required, and skipping any of them is silent: the workspace reducer only
 * accepts `pathChosen` while `picking` and `opened` while `opening`, so a shortcut leaves the
 * status at `empty`. The root reducer's staleness gate then drops every session-scoped action,
 * and a test written against the root reducer asserts nothing at all while appearing to pass its
 * setup.
 */
const opened = (): AppState =>
  [
    { type: 'workspace/openRequested' } as const,
    { type: 'workspace/pathChosen', path: '/w', requestId: 'r0' } as const,
    { type: 'workspace/opened', requestId: 'r0', info: INFO } as const,
  ].reduce<AppState>((state, action) => reduce(state, action).state, initialState);

const indexed = (paths: readonly string[] = ['src/index.ts', 'README.md']): AppState =>
  reduce(opened(), {
    type: 'search/indexReady',
    sessionId: 1,
    paths,
    truncated: false,
  }).state;

const query = (state: AppState, text: string, requestId = 'q1'): ReturnType<typeof reduce> =>
  reduce(state, { type: 'search/queryChanged', sessionId: 1, query: text, requestId });

const response = (overrides: Partial<ContentSearchResponse> = {}): ContentSearchResponse => ({
  query: 'needle',
  requestId: 'q1',
  matches: [{ path: 'src/index.ts', line: 3, column: 1, preview: 'a needle here' }],
  truncated: false,
  filesScanned: 12,
  ...overrides,
});

describe('the index', () => {
  it('is building as soon as the workspace opens', () => {
    // Main starts walking as part of opening, so the UI can say "indexing" rather than showing an
    // empty index that reads as "your file does not exist".
    expect(opened().search.index).toEqual({ status: 'building' });
  });

  it('becomes ready when main delivers it', () => {
    expect(indexed().search.index).toEqual({
      status: 'ready',
      paths: ['src/index.ts', 'README.md'],
      truncated: false,
    });
  });

  it('applies an add', () => {
    const next = reduce(indexed(), {
      type: 'search/indexChanged',
      sessionId: 1,
      added: ['src/new.ts'],
      removed: [],
    }).state;

    expect(next.search.index).toMatchObject({ paths: expect.arrayContaining(['src/new.ts']) });
  });

  it('applies a removal', () => {
    const next = reduce(indexed(), {
      type: 'search/indexChanged',
      sessionId: 1,
      added: [],
      removed: ['README.md'],
    }).state;

    expect(next.search.index).toMatchObject({ paths: ['src/index.ts'] });
  });

  it('does not duplicate a path that is already indexed', () => {
    const next = reduce(indexed(), {
      type: 'search/indexChanged',
      sessionId: 1,
      added: ['README.md'],
      removed: [],
    }).state;

    // Both sides apply the same deltas from the same source, so a redelivery has to be harmless.
    expect(next.search.index).toMatchObject({ paths: ['src/index.ts', 'README.md'] });
  });

  it('ignores a delta that changes nothing', () => {
    const before = indexed();

    const after = reduce(before, {
      type: 'search/indexChanged',
      sessionId: 1,
      added: ['README.md'],
      removed: ['never-existed.ts'],
    });

    // Identity, so nothing re-renders.
    expect(after.state).toBe(before);
  });

  it('drops a delta from a workspace that is no longer open', () => {
    const before = indexed();

    const after = reduce(before, {
      type: 'search/indexChanged',
      sessionId: 99,
      added: ['other.ts'],
      removed: [],
    });

    expect(after.state).toBe(before);
  });

  it('is discarded when the workspace closes', () => {
    const closed = reduce(indexed(), { type: 'workspace/closed', sessionId: 1 }).state;

    expect(closed.search.index).toEqual({ status: 'idle' });
  });
});

describe('path mode', () => {
  it('emits no effect when the query changes', () => {
    /*
     * The requirement, enforced structurally. If this ever produces an effect, path search has
     * started doing IPC per keystroke and the spec's constraint is gone — with no other symptom
     * than the overlay feeling slightly worse on a large repository.
     */
    const result = query(indexed(), 'ind');

    expect(result.effects).toEqual([]);
    expect(result.state.search.query).toBe('ind');
  });

  it('emits no effect however long the query gets', () => {
    let state = indexed();
    const effects: unknown[] = [];
    for (const text of ['s', 'sr', 'src', 'src/i', 'src/in']) {
      const result = query(state, text);
      state = result.state;
      effects.push(...result.effects);
    }

    expect(effects).toEqual([]);
  });
});

describe('content mode', () => {
  const inContentMode = (): AppState =>
    reduce(indexed(), {
      type: 'search/modeChanged',
      sessionId: 1,
      mode: 'content',
      requestId: 'm1',
    }).state;

  it('runs a search when the query changes', () => {
    const result = query(inContentMode(), 'needle');

    expect(result.effects).toEqual([
      { type: 'search/content', sessionId: 1, query: 'needle', requestId: 'q1' },
    ]);
    expect(result.state.search.content.status).toBe('searching');
  });

  it('runs the query already typed when the mode is switched', () => {
    const withQuery = query(indexed(), 'needle').state;

    const result = reduce(withQuery, {
      type: 'search/modeChanged',
      sessionId: 1,
      mode: 'content',
      requestId: 'm1',
    });

    // Rather than making the user retype what is in the box in front of them.
    expect(result.effects).toEqual([
      { type: 'search/content', sessionId: 1, query: 'needle', requestId: 'm1' },
    ]);
  });

  it('clears the results when the query is emptied', () => {
    const searched = query(inContentMode(), 'needle').state;

    const cleared = query(searched, '', 'q2');

    expect(cleared.effects).toEqual([]);
    expect(cleared.state.search.content).toEqual({ status: 'idle' });
  });

  it('shows a result for the current query', () => {
    const searching = query(inContentMode(), 'needle').state;

    const done = reduce(searching, {
      type: 'search/contentLoaded',
      sessionId: 1,
      requestId: 'q1',
      response: response(),
    }).state;

    expect(done.search.content).toMatchObject({ status: 'ready', filesScanned: 12 });
  });

  it('drops a result for a query that has been superseded', () => {
    /*
     * The concrete failure: a search over a big repository for `a` is still running when the user
     * has finished typing `authenticate`. Without this gate its hundreds of matches land on
     * screen, replacing the correct answer, and the list appears to flicker between two queries.
     */
    const first = query(inContentMode(), 'a', 'q1').state;
    const second = query(first, 'authenticate', 'q2').state;

    const late = reduce(second, {
      type: 'search/contentLoaded',
      sessionId: 1,
      requestId: 'q1',
      response: response({ query: 'a', requestId: 'q1' }),
    });

    // Identity: the stale answer does not even cause a re-render.
    expect(late.state).toBe(second);
    expect(second.search.content.status).toBe('searching');
  });

  it('drops a failure for a superseded query too', () => {
    const first = query(inContentMode(), 'a', 'q1').state;
    const second = query(first, 'authenticate', 'q2').state;

    const late = reduce(second, {
      type: 'search/contentFailed',
      sessionId: 1,
      requestId: 'q1',
      error: { code: 'internal', message: 'boom' },
    });

    expect(late.state).toBe(second);
  });

  it('reports a failure for the current query', () => {
    const searching = query(inContentMode(), 'needle').state;

    const failed = reduce(searching, {
      type: 'search/contentFailed',
      sessionId: 1,
      requestId: 'q1',
      error: { code: 'internal', message: 'boom' },
    }).state;

    expect(failed.search.content).toEqual({
      status: 'error',
      error: { code: 'internal', message: 'boom' },
    });
  });

  it('carries the truncated flag through to state', () => {
    const searching = query(inContentMode(), 'needle').state;

    const done = reduce(searching, {
      type: 'search/contentLoaded',
      sessionId: 1,
      requestId: 'q1',
      response: response({ truncated: true }),
    }).state;

    expect(done.search.content).toMatchObject({ truncated: true });
  });
});

describe('mode switching', () => {
  it('clears results that belonged to the other mode', () => {
    const inContent = reduce(indexed(), {
      type: 'search/modeChanged',
      sessionId: 1,
      mode: 'content',
      requestId: 'm1',
    }).state;
    const searched = reduce(query(inContent, 'needle').state, {
      type: 'search/contentLoaded',
      sessionId: 1,
      requestId: 'q1',
      response: response(),
    }).state;

    const backToPaths = reduce(searched, {
      type: 'search/modeChanged',
      sessionId: 1,
      mode: 'path',
      requestId: 'm2',
    }).state;

    // Leaving content matches on screen under a heading that says "file paths" is the wrong kind
    // of fast.
    expect(backToPaths.search.content).toEqual({ status: 'idle' });
  });

  it('does nothing when the mode is already selected', () => {
    const before = indexed();

    const after = reduce(before, {
      type: 'search/modeChanged',
      sessionId: 1,
      mode: 'path',
      requestId: 'm1',
    });

    expect(after.state).toBe(before);
    expect(after.effects).toEqual([]);
  });

  it('keeps the query when the overlay closes', () => {
    const typed = query(indexed(), 'needle').state;

    const closed = reduce(typed, { type: 'overlay/closed' }).state;

    // Reopening search to refine what you just typed is the common case.
    expect(closed.search.query).toBe('needle');
  });
});

describe('effect ordering', () => {
  it('keeps two searches in one burst distinct', () => {
    const actions: readonly Action[] = [
      { type: 'search/queryChanged', sessionId: 1, query: 'a', requestId: 'q1' },
      { type: 'search/queryChanged', sessionId: 1, query: 'ab', requestId: 'q2' },
    ];
    const inContent = reduce(indexed(), {
      type: 'search/modeChanged',
      sessionId: 1,
      mode: 'content',
      requestId: 'm1',
    }).state;

    let state = inContent;
    const effects = actions.flatMap((action) => {
      const result = reduce(state, action);
      state = result.state;
      return [...result.effects];
    });

    // Different queries are different work; collapsing them would leave main searching for a
    // query the user has already moved past.
    expect(effects).toHaveLength(2);
  });
});
