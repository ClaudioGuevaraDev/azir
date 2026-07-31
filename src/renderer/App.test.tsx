import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppBridge } from '@shared/bridge';
import type { WorkspaceInfo } from '@shared/ipc/contracts';
import type { Result } from '@shared/ipc/result';
import { App } from './App';
import { StoreProvider } from './app/react';
import { createEffectRunner } from './app/runtime/effectRunner';
import { resetRequestIds } from './app/runtime/requestIds';
import { createStore } from './app/store';
import { createTerminalRegistry } from './terminal/registry';

/**
 * The whole loop, end to end with the real reducer, real store and real effect
 * runner — only the bridge is faked. This is the test that would catch a wiring
 * mistake that every isolated unit test passes through.
 */

const info = (name: string, sessionId: number): WorkspaceInfo => ({
  sessionId,
  root: `/work/${name}`,
  name,
});

interface Harness {
  readonly pickFolder: ReturnType<typeof vi.fn>;
  readonly open: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
  readonly createTerminal: ReturnType<typeof vi.fn>;
}

const renderApp = (): Harness => {
  const pickFolder = vi.fn<() => Promise<Result<string | null>>>();
  const open = vi.fn<() => Promise<Result<WorkspaceInfo>>>();
  const close = vi.fn<() => Promise<Result<{ closed: boolean }>>>();
  // Opening a workspace autostarts a terminal, so the bridge needs the terminal
  // surface even for the workspace-level assertions below.
  const createTerminal = vi.fn(async () => ({
    ok: true as const,
    value: { paneId: 'p1', shellPath: 'pwsh.exe', cwd: '/work/repo', pid: 1 },
  }));

  // Opening a workspace also loads the repository root, so the bridge needs the
  // files surface even for the workspace-level assertions below.
  const listDirectory = vi.fn(async () => ({
    ok: true as const,
    value: { path: '', entries: [] },
  }));

  const bridge = {
    app: { ping: vi.fn() },
    workspace: { pickFolder, open, close },
    files: { listDirectory },
    terminal: {
      create: createTerminal,
      write: vi.fn(),
      resize: vi.fn(),
      kill: vi.fn(),
      onData: vi.fn(() => () => {}),
      onExit: vi.fn(() => () => {}),
    },
  } as unknown as AppBridge;

  const store = createStore({ runEffect: createEffectRunner(bridge) });

  render(
    <StoreProvider store={store}>
      <App registry={createTerminalRegistry()} transport={bridge.terminal} />
    </StoreProvider>,
  );

  return { pickFolder, open, close, createTerminal };
};

beforeEach(() => {
  resetRequestIds();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('opening a workspace', () => {
  it('goes from the welcome screen to the workspace shell', async () => {
    const user = userEvent.setup();
    const harness = renderApp();
    harness.pickFolder.mockResolvedValue({ ok: true, value: '/work/repo' });
    harness.open.mockResolvedValue({ ok: true, value: info('repo', 1) });

    expect(screen.getByTestId('welcome')).toBeInTheDocument();

    await user.click(screen.getByTestId('open-workspace'));

    await waitFor(() => {
      expect(screen.getByTestId('workspace-shell')).toBeInTheDocument();
    });
    expect(screen.getByTestId('workspace-name')).toHaveTextContent('repo');
    expect(screen.queryByTestId('welcome')).not.toBeInTheDocument();
  });

  it('returns to the welcome screen when the picker is cancelled', async () => {
    const user = userEvent.setup();
    const harness = renderApp();
    harness.pickFolder.mockResolvedValue({ ok: true, value: null });

    await user.click(screen.getByTestId('open-workspace'));

    await waitFor(() => {
      expect(screen.getByTestId('open-workspace')).toBeEnabled();
    });
    expect(screen.getByTestId('welcome')).toBeInTheDocument();
    expect(screen.queryByTestId('welcome-error')).not.toBeInTheDocument();
    expect(harness.open).not.toHaveBeenCalled();
  });

  it('shows the failure and stays retryable', async () => {
    const user = userEvent.setup();
    const harness = renderApp();
    harness.pickFolder.mockResolvedValue({ ok: true, value: '/nope' });
    harness.open.mockResolvedValue({
      ok: false,
      error: { code: 'not-found', message: 'That folder could not be opened.' },
    });

    await user.click(screen.getByTestId('open-workspace'));

    await waitFor(() => {
      expect(screen.getByTestId('welcome-error')).toHaveTextContent(
        'That folder could not be opened.',
      );
    });

    // A failed open must not be a dead end.
    harness.pickFolder.mockResolvedValue({ ok: true, value: '/work/repo' });
    harness.open.mockResolvedValue({ ok: true, value: info('repo', 2) });
    await user.click(screen.getByTestId('open-workspace'));

    await waitFor(() => {
      expect(screen.getByTestId('workspace-shell')).toBeInTheDocument();
    });
  });

  it('disables the button while the request is in flight', async () => {
    const user = userEvent.setup();
    const harness = renderApp();
    let release: ((value: Result<string | null>) => void) | undefined;
    harness.pickFolder.mockReturnValue(
      new Promise<Result<string | null>>((resolve) => {
        release = resolve;
      }),
    );

    await user.click(screen.getByTestId('open-workspace'));

    await waitFor(() => {
      expect(screen.getByTestId('open-workspace')).toBeDisabled();
    });

    release?.({ ok: true, value: null });
  });

  it('opens exactly one dialog even if the button is clicked repeatedly', async () => {
    const user = userEvent.setup();
    const harness = renderApp();
    harness.pickFolder.mockReturnValue(new Promise<Result<string | null>>(() => {}));

    const button = screen.getByTestId('open-workspace');
    await user.click(button);
    await user.click(button);
    await user.click(button);

    // Guarded twice over: the reducer ignores a second request while picking, and
    // the button is disabled.
    expect(harness.pickFolder).toHaveBeenCalledTimes(1);
  });
});

describe('closing a workspace', () => {
  it('tears down and returns to the welcome screen', async () => {
    const user = userEvent.setup();
    const harness = renderApp();
    harness.pickFolder.mockResolvedValue({ ok: true, value: '/work/repo' });
    harness.open.mockResolvedValue({ ok: true, value: info('repo', 1) });
    harness.close.mockResolvedValue({ ok: true, value: { closed: true } });

    await user.click(screen.getByTestId('open-workspace'));
    await waitFor(() => {
      expect(screen.getByTestId('workspace-shell')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('close-workspace'));

    await waitFor(() => {
      expect(screen.getByTestId('welcome')).toBeInTheDocument();
    });
    expect(harness.close).toHaveBeenCalledWith({ sessionId: 1 });
  });

  it('surfaces a dirty teardown as a dismissible notice without trapping the user', async () => {
    const user = userEvent.setup();
    const harness = renderApp();
    harness.pickFolder.mockResolvedValue({ ok: true, value: '/work/repo' });
    harness.open.mockResolvedValue({ ok: true, value: info('repo', 1) });
    harness.close.mockResolvedValue({
      ok: false,
      error: { code: 'internal', message: 'pty refused to die' },
    });

    await user.click(screen.getByTestId('open-workspace'));
    await waitFor(() => {
      expect(screen.getByTestId('workspace-shell')).toBeInTheDocument();
    });

    await user.click(screen.getByTestId('close-workspace'));

    await waitFor(() => {
      expect(screen.getByTestId('notices')).toBeInTheDocument();
    });
    // Still returned to the welcome screen: the workspace is gone as far as the
    // renderer is concerned.
    expect(screen.getByTestId('welcome')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Dismiss' }));

    expect(screen.queryByTestId('notices')).not.toBeInTheDocument();
  });
});

describe('opening a second workspace', () => {
  it('replaces the first one completely', async () => {
    const user = userEvent.setup();
    const harness = renderApp();
    harness.pickFolder.mockResolvedValue({ ok: true, value: '/work/alpha' });
    harness.open.mockResolvedValue({ ok: true, value: info('alpha', 1) });
    harness.close.mockResolvedValue({ ok: true, value: { closed: true } });

    await user.click(screen.getByTestId('open-workspace'));
    await waitFor(() => {
      expect(screen.getByTestId('workspace-name')).toHaveTextContent('alpha');
    });

    await user.click(screen.getByTestId('close-workspace'));
    await waitFor(() => {
      expect(screen.getByTestId('welcome')).toBeInTheDocument();
    });

    harness.pickFolder.mockResolvedValue({ ok: true, value: '/work/beta' });
    harness.open.mockResolvedValue({ ok: true, value: info('beta', 2) });
    await user.click(screen.getByTestId('open-workspace'));

    await waitFor(() => {
      expect(screen.getByTestId('workspace-name')).toHaveTextContent('beta');
    });
  });
});
