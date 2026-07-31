import { describe, expect, it } from 'vitest';
import type { WorkspaceInfo } from '@shared/ipc/contracts';
import type { Action } from '../actions';
import type { TerminalPaneState, TerminalsState } from '../state';
import { terminalsReducer } from './terminals';

const info: WorkspaceInfo = { sessionId: 1, root: '/work/repo', name: 'repo' };

const empty: TerminalsState = { panes: [], activePaneId: null, nextPaneSeq: 1 };

const pane = (id: string, overrides: Partial<TerminalPaneState> = {}): TerminalPaneState => ({
  id,
  title: 'pwsh',
  lifecycle: 'running',
  cwd: '/work/repo',
  exitCode: null,
  hasUnreadOutput: false,
  ...overrides,
});

const withPanes = (panes: TerminalPaneState[], activePaneId: string | null): TerminalsState => ({
  panes,
  activePaneId,
  nextPaneSeq: panes.length + 1,
});

const run = (state: TerminalsState, ...actions: Action[]): TerminalsState =>
  actions.reduce((current, action) => terminalsReducer(current, action).state, state);

describe('autostart', () => {
  it('starts one pane when a workspace opens', () => {
    // The spec's startup sequence ends with creating the initial PTY, and requires
    // the collection never to be empty while a workspace is active.
    const result = terminalsReducer(empty, { type: 'workspace/opened', requestId: 'r1', info });

    expect(result.state.panes).toHaveLength(1);
    expect(result.state.activePaneId).toBe('p1');
    expect(result.effects).toEqual([{ type: 'terminal/create', sessionId: 1, paneId: 'p1' }]);
  });

  it('starts the pane in the workspace root', () => {
    const result = terminalsReducer(empty, { type: 'workspace/opened', requestId: 'r1', info });

    expect(result.state.panes[0]?.cwd).toBe('/work/repo');
    expect(result.state.panes[0]?.lifecycle).toBe('starting');
  });

  it("replaces the previous workspace's panes rather than appending to them", () => {
    const previous = withPanes([pane('p1'), pane('p2')], 'p2');

    const result = terminalsReducer(previous, {
      type: 'workspace/opened',
      requestId: 'r1',
      info: { ...info, sessionId: 2 },
    });

    expect(result.state.panes.map((p) => p.id)).toEqual(['p3']);
  });
});

describe('pane identity', () => {
  it('never reuses an id, even across close and reopen', () => {
    // This is what stops late PTY output from a killed shell being delivered to the
    // pane that took its visual slot.
    let state = run(empty, { type: 'terminal/createRequested', sessionId: 1 });
    const first = state.panes[0]?.id;

    state = run(state, { type: 'terminal/closeRequested', sessionId: 1, paneId: first ?? '' });
    state = run(state, { type: 'terminal/createRequested', sessionId: 1 });
    const second = state.panes[0]?.id;

    expect(first).toBe('p1');
    expect(second).toBe('p2');
  });

  it('keeps the counter across a workspace change', () => {
    let state = run(empty, { type: 'workspace/opened', requestId: 'r1', info });
    state = run(state, { type: 'workspace/closed', sessionId: 1 });
    state = run(state, {
      type: 'workspace/opened',
      requestId: 'r2',
      info: { ...info, sessionId: 2 },
    });

    expect(state.panes[0]?.id).toBe('p2');
  });
});

describe('creating panes', () => {
  it('appends and activates', () => {
    const state = run(withPanes([pane('p1')], 'p1'), {
      type: 'terminal/createRequested',
      sessionId: 1,
    });

    expect(state.panes.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(state.activePaneId).toBe('p2');
  });

  it('stops at the ceiling without emitting an effect', () => {
    const full = withPanes(
      Array.from({ length: 8 }, (_, index) => pane(`p${index + 1}`)),
      'p1',
    );

    const result = terminalsReducer(full, { type: 'terminal/createRequested', sessionId: 1 });

    expect(result.state).toBe(full);
    expect(result.effects).toEqual([]);
  });

  it('records the shell that main actually started', () => {
    const state = run(run(empty, { type: 'terminal/createRequested', sessionId: 1 }), {
      type: 'terminal/created',
      sessionId: 1,
      paneId: 'p1',
      shellPath: 'C:\\Program Files\\Git\\bin\\bash.exe',
      cwd: '/work/repo',
    });

    expect(state.panes[0]).toMatchObject({ lifecycle: 'running', title: 'bash' });
  });

  it.each([
    ['powershell.exe', 'powershell'],
    ['/bin/zsh', 'zsh'],
    ['pwsh.exe', 'pwsh'],
  ])('derives the title %s → %s', (shellPath, expected) => {
    const state = run(run(empty, { type: 'terminal/createRequested', sessionId: 1 }), {
      type: 'terminal/created',
      sessionId: 1,
      paneId: 'p1',
      shellPath,
      cwd: '/work/repo',
    });

    expect(state.panes[0]?.title).toBe(expected);
  });

  it('marks the pane failed and keeps it, so the error is visible', () => {
    const state = run(run(empty, { type: 'terminal/createRequested', sessionId: 1 }), {
      type: 'terminal/createFailed',
      sessionId: 1,
      paneId: 'p1',
      error: { code: 'pty-failed', message: 'Could not start powershell.exe.' },
    });

    expect(state.panes[0]).toMatchObject({ lifecycle: 'failed' });
    expect(state.panes[0]?.error?.code).toBe('pty-failed');
  });

  it('ignores a created response for a pane that was already closed', () => {
    const state = withPanes([pane('p2')], 'p2');

    const result = terminalsReducer(state, {
      type: 'terminal/created',
      sessionId: 1,
      paneId: 'p1',
      shellPath: 'pwsh.exe',
      cwd: '/work/repo',
    });

    // Must not resurrect it.
    expect(result.state).toBe(state);
  });
});

describe('exiting', () => {
  it('keeps the pane and shows its exit code', () => {
    // A shell that died because a command ran `exit` should leave visible evidence.
    const state = run(withPanes([pane('p1')], 'p1'), {
      type: 'terminal/exited',
      sessionId: 1,
      paneId: 'p1',
      exitCode: 130,
    });

    expect(state.panes[0]).toMatchObject({ lifecycle: 'exited', exitCode: 130 });
    expect(state.activePaneId).toBe('p1');
  });

  it('handles a null exit code', () => {
    const state = run(withPanes([pane('p1')], 'p1'), {
      type: 'terminal/exited',
      sessionId: 1,
      paneId: 'p1',
      exitCode: null,
    });

    expect(state.panes[0]?.exitCode).toBeNull();
  });

  it('ignores an exit for an unknown pane', () => {
    const state = withPanes([pane('p1')], 'p1');

    const result = terminalsReducer(state, {
      type: 'terminal/exited',
      sessionId: 1,
      paneId: 'ghost',
      exitCode: 0,
    });

    expect(result.state).toBe(state);
  });
});

describe('closing panes', () => {
  it('removes the pane and asks main to kill it', () => {
    const result = terminalsReducer(withPanes([pane('p1'), pane('p2')], 'p1'), {
      type: 'terminal/closeRequested',
      sessionId: 1,
      paneId: 'p1',
    });

    expect(result.state.panes.map((p) => p.id)).toEqual(['p2']);
    expect(result.effects).toEqual([{ type: 'terminal/kill', sessionId: 1, paneId: 'p1' }]);
  });

  it('moves focus rightwards, not back to the first pane', () => {
    const state = run(withPanes([pane('p1'), pane('p2'), pane('p3')], 'p2'), {
      type: 'terminal/closeRequested',
      sessionId: 1,
      paneId: 'p2',
    });

    expect(state.activePaneId).toBe('p3');
  });

  it('falls back to the last pane when the rightmost is closed', () => {
    const state = run(withPanes([pane('p1'), pane('p2')], 'p2'), {
      type: 'terminal/closeRequested',
      sessionId: 1,
      paneId: 'p2',
    });

    expect(state.activePaneId).toBe('p1');
  });

  it('leaves focus alone when closing an inactive pane', () => {
    const state = run(withPanes([pane('p1'), pane('p2')], 'p1'), {
      type: 'terminal/closeRequested',
      sessionId: 1,
      paneId: 'p2',
    });

    expect(state.activePaneId).toBe('p1');
  });

  it('clears focus when the last pane closes', () => {
    const state = run(withPanes([pane('p1')], 'p1'), {
      type: 'terminal/closeRequested',
      sessionId: 1,
      paneId: 'p1',
    });

    expect(state.panes).toEqual([]);
    expect(state.activePaneId).toBeNull();
  });

  it('ignores a close for an unknown pane and emits no kill', () => {
    const state = withPanes([pane('p1')], 'p1');

    const result = terminalsReducer(state, {
      type: 'terminal/closeRequested',
      sessionId: 1,
      paneId: 'ghost',
    });

    expect(result.state).toBe(state);
    expect(result.effects).toEqual([]);
  });
});

describe('workspace disposal', () => {
  it('drops all panes without emitting kill effects', () => {
    // Main already kills them through the session's dispose listeners; emitting
    // kills here would race that teardown and produce unknown-pane errors.
    const result = terminalsReducer(withPanes([pane('p1'), pane('p2')], 'p1'), {
      type: 'workspace/closed',
      sessionId: 1,
    });

    expect(result.state.panes).toEqual([]);
    expect(result.state.activePaneId).toBeNull();
    expect(result.effects).toEqual([]);
  });

  it('preserves identity when there was nothing to drop', () => {
    const result = terminalsReducer(empty, { type: 'workspace/closed', sessionId: 1 });

    expect(result.state).toBe(empty);
  });
});

describe('activation and unread output', () => {
  it('switching panes does not remove or recreate either one', () => {
    // The spec requires that switching the active pane does not recreate xterm.js or
    // node-pty; the reducer's part of that is simply not touching the pane list.
    const state = withPanes([pane('p1'), pane('p2')], 'p1');

    const result = terminalsReducer(state, { type: 'terminal/activated', paneId: 'p2' });

    expect(result.state.panes).toBe(state.panes);
    expect(result.state.activePaneId).toBe('p2');
    expect(result.effects).toEqual([]);
  });

  it('clears the unread marker on activation', () => {
    const state = run(withPanes([pane('p1'), pane('p2', { hasUnreadOutput: true })], 'p1'), {
      type: 'terminal/activated',
      paneId: 'p2',
    });

    expect(state.panes[1]?.hasUnreadOutput).toBe(false);
  });

  it('clears the marker when the already-active pane is clicked', () => {
    const state = run(withPanes([pane('p1', { hasUnreadOutput: true })], 'p1'), {
      type: 'terminal/activated',
      paneId: 'p1',
    });

    expect(state.panes[0]?.hasUnreadOutput).toBe(false);
  });

  it('ignores activation of an unknown pane', () => {
    const state = withPanes([pane('p1')], 'p1');

    expect(terminalsReducer(state, { type: 'terminal/activated', paneId: 'ghost' }).state).toBe(
      state,
    );
  });

  it('marks a hidden pane unread', () => {
    const state = run(withPanes([pane('p1'), pane('p2')], 'p1'), {
      type: 'terminal/activity',
      sessionId: 1,
      paneId: 'p2',
    });

    expect(state.panes[1]?.hasUnreadOutput).toBe(true);
  });

  it('never marks the active pane unread', () => {
    const state = withPanes([pane('p1')], 'p1');

    const result = terminalsReducer(state, {
      type: 'terminal/activity',
      sessionId: 1,
      paneId: 'p1',
    });

    expect(result.state).toBe(state);
  });

  it('preserves identity when the pane is already marked, so a noisy shell stops re-rendering', () => {
    const state = withPanes([pane('p1'), pane('p2', { hasUnreadOutput: true })], 'p1');

    const result = terminalsReducer(state, {
      type: 'terminal/activity',
      sessionId: 1,
      paneId: 'p2',
    });

    expect(result.state).toBe(state);
  });
});
