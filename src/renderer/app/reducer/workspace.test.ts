import { describe, expect, it } from 'vitest';
import type { WorkspaceInfo } from '@shared/ipc/contracts';
import type { AppError } from '@shared/ipc/result';
import type { Action } from '../actions';
import type { WorkspaceState } from '../state';
import { workspaceReducer } from './workspace';

const info = (sessionId: number, name = 'repo'): WorkspaceInfo => ({
  sessionId,
  root: `/work/${name}`,
  name,
});

const error: AppError = { code: 'not-found', message: 'That folder could not be opened.' };

const empty: WorkspaceState = { status: 'empty' };
const picking: WorkspaceState = { status: 'picking' };
const opening = (requestId: string): WorkspaceState => ({
  status: 'opening',
  requestId,
  path: '/work/repo',
});
const open = (sessionId: number): WorkspaceState => ({ status: 'open', info: info(sessionId) });

const run = (state: WorkspaceState, ...actions: Action[]): WorkspaceState =>
  actions.reduce((current, action) => workspaceReducer(current, action).state, state);

describe('happy path', () => {
  it('walks empty → picking → opening → open, requesting the right work at each step', () => {
    const first = workspaceReducer(empty, { type: 'workspace/openRequested' });
    expect(first.state.status).toBe('picking');
    expect(first.effects).toEqual([{ type: 'workspace/pickFolder' }]);

    const second = workspaceReducer(first.state, {
      type: 'workspace/pathChosen',
      path: '/work/repo',
      requestId: 'r1',
    });
    expect(second.state.status).toBe('opening');
    expect(second.effects).toEqual([
      { type: 'workspace/open', path: '/work/repo', requestId: 'r1' },
    ]);

    const third = workspaceReducer(second.state, {
      type: 'workspace/opened',
      requestId: 'r1',
      info: info(1),
    });
    expect(third.state).toEqual({ status: 'open', info: info(1) });
    expect(third.effects).toEqual([]);
  });

  it('treats a cancelled picker as nothing-open, not as an error', () => {
    const result = run(picking, { type: 'workspace/pickCancelled' });

    expect(result).toEqual(empty);
  });

  it('closes an open workspace and asks main to tear it down', () => {
    const result = workspaceReducer(open(7), { type: 'workspace/closeRequested' });

    expect(result.state).toEqual(empty);
    expect(result.effects).toEqual([{ type: 'workspace/close', sessionId: 7 }]);
  });
});

describe('stale response rejection', () => {
  it('drops a response whose request id has been superseded', () => {
    // Open A, then open B before A answers. A's late success must not win.
    const state = opening('r2');

    const result = workspaceReducer(state, {
      type: 'workspace/opened',
      requestId: 'r1',
      info: info(1),
    });

    expect(result.state).toBe(state);
    expect(result.effects).toEqual([]);
  });

  it('drops a superseded failure too, so an old error cannot mask a live open', () => {
    const state = opening('r2');

    const result = workspaceReducer(state, {
      type: 'workspace/openFailed',
      requestId: 'r1',
      error,
    });

    expect(result.state).toBe(state);
  });

  it('accepts the matching response', () => {
    const result = workspaceReducer(opening('r2'), {
      type: 'workspace/opened',
      requestId: 'r2',
      info: info(2),
    });

    expect(result.state).toEqual({ status: 'open', info: info(2) });
  });

  it.each<[string, WorkspaceState]>([
    ['empty', empty],
    ['picking', picking],
    ['open', open(1)],
    ['failed', { status: 'failed', error }],
  ])('ignores a response that arrives while the slice is %s', (_label, state) => {
    const result = workspaceReducer(state, {
      type: 'workspace/opened',
      requestId: 'r1',
      info: info(9),
    });

    expect(result.state).toBe(state);
  });
});

describe('guards against impossible transitions', () => {
  it('ignores a second open request while the picker is up', () => {
    const result = workspaceReducer(picking, { type: 'workspace/openRequested' });

    // The native picker is modal; a second one would be a UI bug, and firing a
    // second pickFolder effect would open two dialogs.
    expect(result.state).toBe(picking);
    expect(result.effects).toEqual([]);
  });

  it('ignores a second open request while a folder is already opening', () => {
    const state = opening('r1');

    expect(workspaceReducer(state, { type: 'workspace/openRequested' }).effects).toEqual([]);
  });

  it('ignores a chosen path that arrives when no picker was open', () => {
    const result = workspaceReducer(empty, {
      type: 'workspace/pathChosen',
      path: '/work/repo',
      requestId: 'r1',
    });

    expect(result.state).toBe(empty);
    expect(result.effects).toEqual([]);
  });

  it('ignores a close request when nothing is open', () => {
    const result = workspaceReducer(empty, { type: 'workspace/closeRequested' });

    expect(result.state).toBe(empty);
    expect(result.effects).toEqual([]);
  });

  it('ignores a closed confirmation for a different session', () => {
    const state = open(7);

    const result = workspaceReducer(state, { type: 'workspace/closed', sessionId: 3 });

    expect(result.state).toBe(state);
  });

  it('accepts a closed confirmation for the live session', () => {
    const result = workspaceReducer(open(7), { type: 'workspace/closed', sessionId: 7 });

    expect(result.state).toEqual(empty);
  });
});

describe('recovery', () => {
  it('lets the user retry after a failure', () => {
    const failed = run(picking, { type: 'workspace/pickFailed', error });
    expect(failed.status).toBe('failed');

    const retried = workspaceReducer(failed, { type: 'workspace/openRequested' });

    expect(retried.state.status).toBe('picking');
    expect(retried.effects).toEqual([{ type: 'workspace/pickFolder' }]);
  });

  it('surfaces the error that caused the failure', () => {
    const result = workspaceReducer(opening('r1'), {
      type: 'workspace/openFailed',
      requestId: 'r1',
      error,
    });

    expect(result.state).toEqual({ status: 'failed', error });
  });
});
