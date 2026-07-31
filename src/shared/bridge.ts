import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  GitStatusRequest,
  GitStatusResponse,
  KillTerminalRequest,
  ListDirectoryRequest,
  ListDirectoryResponse,
  PickFolderResponse,
  PingRequest,
  PingResponse,
  ResizeTerminalRequest,
  TerminalDataEvent,
  TerminalExitEvent,
  WorkspaceCloseRequest,
  WorkspaceCloseResponse,
  WorkspaceInfo,
  WorkspaceOpenRequest,
  WriteTerminalRequest,
} from './ipc/contracts';
import type { Result } from './ipc/result';

/** Returned by every `on*` subscription so callers can detach. */
export type Unsubscribe = () => void;

/**
 * The public boundary between the renderer and Electron.
 *
 * docs/architecture.md: "The bridge exposes domain operations, not raw
 * ipcRenderer." The renderer compiles against this interface and nothing else;
 * the preload is its only implementation, and a fake implementation of it is how
 * the effect runner and the terminal controller get tested without Electron.
 *
 * Every request/response method returns `Result` rather than rejecting — see
 * ipc/result.ts.
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

  readonly files: {
    listDirectory(request: ListDirectoryRequest): Promise<Result<ListDirectoryResponse>>;
  };

  readonly git: {
    /**
     * A failure here is expected and survivable: no git binary, not a repository,
     * no commits yet. The tree stays fully usable either way (invariant 13).
     */
    status(request: GitStatusRequest): Promise<Result<GitStatusResponse>>;
  };

  readonly terminal: {
    create(request: CreateTerminalRequest): Promise<Result<CreateTerminalResponse>>;
    /**
     * Keystrokes and resizes are fire-and-forget and deliberately *not* routed
     * through the reducer. They carry no application state, and a round trip per
     * keypress or per pixel of a window drag would make the terminal feel worse
     * than the shell it is hosting.
     */
    write(request: WriteTerminalRequest): void;
    resize(request: ResizeTerminalRequest): void;
    kill(request: KillTerminalRequest): void;
    onData(listener: (event: TerminalDataEvent) => void): Unsubscribe;
    onExit(listener: (event: TerminalExitEvent) => void): Unsubscribe;
  };
}
