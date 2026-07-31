import type {
  PickFolderResponse,
  PingRequest,
  PingResponse,
  WorkspaceCloseRequest,
  WorkspaceCloseResponse,
  WorkspaceInfo,
  WorkspaceOpenRequest,
} from './ipc/contracts';
import type { Result } from './ipc/result';

/**
 * The public boundary between the renderer and Electron.
 *
 * docs/architecture.md: "The bridge exposes domain operations, not raw
 * ipcRenderer." The renderer compiles against this interface and nothing else;
 * the preload is its only implementation, and a fake implementation of it is how
 * the effect runner gets tested without Electron.
 *
 * Every method returns `Result` rather than rejecting — see ipc/result.ts.
 */
export interface AppBridge {
  readonly app: {
    ping(request: PingRequest): Promise<Result<PingResponse>>;
  };

  readonly workspace: {
    /** Opens the native directory picker. `null` means the user cancelled. */
    pickFolder(): Promise<Result<PickFolderResponse>>;
    open(request: WorkspaceOpenRequest): Promise<Result<WorkspaceInfo>>;
    close(request: WorkspaceCloseRequest): Promise<Result<WorkspaceCloseResponse>>;
  };
}

/** Returned by every `on*` subscription so callers can detach. */
export type Unsubscribe = () => void;
