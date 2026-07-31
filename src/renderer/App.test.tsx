import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PingRequest, PingResponse } from '@shared/ipc/contracts';
import type { Result } from '@shared/ipc/result';
import { App } from './App';

type Ping = (request: PingRequest) => Promise<Result<PingResponse>>;

const installBridge = (ping: Ping): void => {
  Object.defineProperty(window, 'azir', {
    value: { app: { ping } },
    configurable: true,
    writable: true,
  });
};

const response = (nonce: string): PingResponse => ({
  nonce,
  electron: '42.8.0',
  chrome: '142.0.0.0',
  node: '24.18.0',
  platform: 'win32',
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('App', () => {
  it('reports the versions the main process sent back', async () => {
    installBridge(async (request) => ({ ok: true, value: response(request.nonce) }));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('bridge-status')).toHaveAttribute('data-state', 'ready');
    });
    expect(screen.getByText('42.8.0')).toBeInTheDocument();
    expect(screen.getByText('24.18.0')).toBeInTheDocument();
  });

  it('surfaces a bridge failure as state instead of crashing the tree', async () => {
    installBridge(async () => ({
      ok: false,
      error: { code: 'internal', message: 'ipc unavailable' },
    }));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('bridge-status')).toHaveAttribute('data-state', 'error');
    });
    expect(screen.getByText(/ipc unavailable/)).toBeInTheDocument();
  });

  it('rejects a response whose nonce does not match the request', async () => {
    // A response carrying someone else's identity is the shape of the staleness
    // bug the viewer and search panels have to defend against later, so the
    // check is worth having even in the M0 shell.
    installBridge(async () => ({ ok: true, value: response('not-the-nonce-we-sent') }));

    render(<App />);

    await waitFor(() => {
      expect(screen.getByTestId('bridge-status')).toHaveAttribute('data-state', 'error');
    });
    expect(screen.getByText(/nonce did not match/i)).toBeInTheDocument();
  });
});
