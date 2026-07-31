import type { PingRequest, PingResponse } from './ipc/contracts';
import type { Result } from './ipc/result';

/**
 * The public boundary between the renderer and Electron.
 *
 * docs/architecture.md: "The bridge exposes domain operations, not raw
 * ipcRenderer." The renderer compiles against this interface and nothing else;
 * the preload is its only implementation.
 *
 * Every method returns `Result` rather than rejecting — see ipc/result.ts.
 */
export interface AppBridge {
  readonly app: {
    ping(request: PingRequest): Promise<Result<PingResponse>>;
  };
}

/** Returned by every `on*` subscription so callers can detach. */
export type Unsubscribe = () => void;
