import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppBridge } from '@shared/bridge';
import type { TerminalDataEvent, TerminalExitEvent } from '@shared/ipc/contracts';
import { StoreProvider, useAppState } from '../app/react';
import { initialRepositoryState } from '../app/repository';
import { startEventPump } from '../app/runtime/eventPump';
import { createStore, type Store } from '../app/store';
import { selectPanes, type AppState, type TerminalPaneState } from '../app/state';
import { createTerminalRegistry, type TerminalRegistry } from './registry';

/**
 * The enforcement mechanism for performance rules 1–2.
 *
 * docs/architecture.md is explicit that React must not re-render the workspace for
 * every terminal chunk and that output goes "directly to the relevant terminal
 * controller". Nothing in the type system stops someone from adding a
 * `terminal/output` action later and quietly reintroducing exactly that — the
 * result would still compile, still pass every other test, and only show up as a
 * sluggish window during a build.
 *
 * So the property is asserted directly: flood the side channel and count renders.
 */

const flooded = (count: number): TerminalDataEvent[] =>
  Array.from({ length: count }, (_, index) => ({
    sessionId: 1,
    paneId: 'p1',
    data: `line ${index}\r\n`,
  }));

interface Harness {
  readonly store: Store;
  readonly registry: TerminalRegistry;
  readonly emitData: (event: TerminalDataEvent) => void;
  readonly emitExit: (event: TerminalExitEvent) => void;
  readonly renders: () => number;
  readonly sinkWrites: () => number;
}

const openWorkspaceState = (activePaneId: string | null): AppState => {
  const pane: TerminalPaneState = {
    id: 'p1',
    title: 'pwsh',
    lifecycle: 'running',
    cwd: '/work/repo',
    exitCode: null,
    hasUnreadOutput: false,
  };
  return {
    workspace: {
      status: 'open',
      info: { sessionId: 1, root: '/work/repo', name: 'repo' },
    },
    repository: initialRepositoryState,
    terminals: { panes: [pane], activePaneId, nextPaneSeq: 2 },
    notices: { items: [], nextId: 1 },
  };
};

const setup = (activePaneId: string | null): Harness => {
  let dataListener: ((event: TerminalDataEvent) => void) | undefined;
  let exitListener: ((event: TerminalExitEvent) => void) | undefined;

  const bridge = {
    terminal: {
      onData: (listener: (event: TerminalDataEvent) => void) => {
        dataListener = listener;
        return () => {
          dataListener = undefined;
        };
      },
      onExit: (listener: (event: TerminalExitEvent) => void) => {
        exitListener = listener;
        return () => {
          exitListener = undefined;
        };
      },
    },
  } as unknown as AppBridge;

  const registry = createTerminalRegistry();
  const store = createStore({ initialState: openWorkspaceState(activePaneId) });

  const write = vi.fn();
  registry.register('p1', { write });

  // A monotonic clock, so the activity throttle is exercised deterministically
  // rather than depending on how fast the flood happens to run.
  let clock = 0;

  startEventPump({
    bridge,
    registry,
    dispatch: store.dispatch,
    activePaneId: () => store.getState().terminals.activePaneId,
    now: () => clock,
  });

  let renderCount = 0;

  const Probe = (): React.JSX.Element => {
    const panes = useAppState(selectPanes);
    renderCount += 1;
    return <div data-testid="probe">{panes.length}</div>;
  };

  render(
    <StoreProvider store={store}>
      <Probe />
    </StoreProvider>,
  );

  return {
    store,
    registry,
    emitData: (event) => {
      clock += 1;
      dataListener?.(event);
    },
    emitExit: (event) => exitListener?.(event),
    renders: () => renderCount,
    sinkWrites: () => write.mock.calls.length,
  };
};

/**
 * Every emission is wrapped in `act`, which is load-bearing rather than ceremony.
 *
 * React does not render synchronously inside a dispatch: without `act`, the render
 * count stays at its initial value no matter what was dispatched, and the headline
 * assertion below ("10,000 chunks cause zero re-renders") would pass even if every
 * single chunk went through the reducer. That would be a vacuous test guarding the
 * most important performance property in the application.
 */
const floodWithin = (harness: Harness, count: number): void => {
  act(() => {
    for (const event of flooded(count)) {
      harness.emitData(event);
    }
  });
};

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('terminal output never reaches React', () => {
  it('causes zero re-renders for 10,000 chunks on the active pane', () => {
    const harness = setup('p1');
    const before = harness.renders();

    floodWithin(harness, 10_000);

    expect(harness.renders()).toBe(before);
    // ...and every byte still arrived.
    expect(harness.sinkWrites()).toBe(10_000);
  });

  it('leaves state referentially identical', () => {
    const harness = setup('p1');
    const before = harness.store.getState();

    floodWithin(harness, 5_000);

    // Identity, not equality: a new-but-equal AppState would still notify.
    expect(harness.store.getState()).toBe(before);
  });

  it('notifies no subscriber', () => {
    const harness = setup('p1');
    const listener = vi.fn();
    harness.store.subscribe(listener);

    floodWithin(harness, 1_000);

    expect(listener).not.toHaveBeenCalled();
  });

  it('the flood control is real: the same harness does re-render when state changes', () => {
    // Guards the guard. If `act` or the probe's subscription were broken, the three
    // assertions above would pass for the wrong reason.
    const harness = setup('p1');
    const before = harness.renders();

    act(() => {
      harness.store.dispatch({ type: 'terminal/createRequested', sessionId: 1 });
    });

    expect(harness.renders()).toBeGreaterThan(before);
  });
});

describe('activity on a hidden pane', () => {
  it('is throttled to a handful of renders however loud the shell is', () => {
    // The one thing the reducer learns about output. With the clock advancing 1ms
    // per chunk and a 500ms throttle, 10,000 chunks is ~20 actions, not 10,000 —
    // and React coalesces those into fewer renders still.
    const harness = setup(null);
    const before = harness.renders();

    floodWithin(harness, 10_000);

    const renders = harness.renders() - before;
    expect(renders).toBeGreaterThan(0);
    expect(renders).toBeLessThan(30);
  });

  it('marks the pane unread', () => {
    const harness = setup(null);

    floodWithin(harness, 2_000);

    expect(harness.store.getState().terminals.panes[0]?.hasUnreadOutput).toBe(true);
  });

  it('never marks the active pane unread, since its output is already visible', () => {
    const harness = setup('p1');

    floodWithin(harness, 2_000);

    expect(harness.store.getState().terminals.panes[0]?.hasUnreadOutput).toBe(false);
  });
});

describe('discrete facts do go through the reducer', () => {
  it('an exit updates the pane and re-renders', () => {
    const harness = setup('p1');
    const before = harness.renders();

    act(() => {
      harness.emitExit({ sessionId: 1, paneId: 'p1', exitCode: 130 });
    });

    expect(harness.renders()).toBeGreaterThan(before);
    expect(harness.store.getState().terminals.panes[0]).toMatchObject({
      lifecycle: 'exited',
      exitCode: 130,
    });
    expect(screen.getByTestId('probe')).toHaveTextContent('1');
  });

  it('an exit for a stale session is dropped', () => {
    const harness = setup('p1');

    act(() => {
      harness.emitExit({ sessionId: 99, paneId: 'p1', exitCode: 1 });
    });

    // The coarse session gate: a PTY belonging to a workspace that has been
    // replaced must not touch the pane list that exists now.
    expect(harness.store.getState().terminals.panes[0]?.lifecycle).toBe('running');
  });
});
