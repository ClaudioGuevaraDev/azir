import type {
  CreateTerminalRequest,
  CreateTerminalResponse,
  FileDiff,
  FsChangeBatch,
  GitDiffRequest,
  GitStatusRequest,
  GitStatusResponse,
  KillTerminalRequest,
  ListDirectoryRequest,
  ListDirectoryResponse,
  PickFolderResponse,
  PingRequest,
  PingResponse,
  ReadFileRequest,
  ReadFileResponse,
  ResizeTerminalRequest,
  WriteFileRequest,
  WriteFileResponse,
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
    /**
     * Keeps main informed about unsaved work, so `before-quit` can decide synchronously.
     *
     * Pushed rather than asked for: an Electron quit handler cannot await an answer, and
     * preventing the quit to go and fetch one is the dance that does not work — Electron does
     * not restart a cancelled quit sequence from inside it.
     */
    setUnsaved(unsaved: boolean): void;
    /** The user chose to quit anyway. */
    confirmQuit(): void;
    /** Main asking the renderer to confirm a quit with unsaved work. */
    onQuitRequested(listener: () => void): Unsubscribe;
  };

  readonly workspace: {
    /** Opens the native directory picker. `null` means the user cancelled. */
    pickFolder(): Promise<Result<PickFolderResponse>>;
    open(request: WorkspaceOpenRequest): Promise<Result<WorkspaceInfo>>;
    close(request: WorkspaceCloseRequest): Promise<Result<WorkspaceCloseResponse>>;
  };

  readonly files: {
    listDirectory(request: ListDirectoryRequest): Promise<Result<ListDirectoryResponse>>;
    /** Refuses a file that is too large or binary, as a `Result` rather than a throw. */
    read(request: ReadFileRequest): Promise<Result<ReadFileResponse>>;
    write(request: WriteFileRequest): Promise<Result<WriteFileResponse>>;
  };

  readonly fs: {
    /** Coalesced batches of workspace changes. See main/watcher/batcher.ts. */
    onChanged(listener: (batch: FsChangeBatch) => void): Unsubscribe;
  };

  readonly git: {
    /**
     * A failure here is expected and survivable: no git binary, not a repository,
     * no commits yet. The tree stays fully usable either way (invariant 13).
     */
    status(request: GitStatusRequest): Promise<Result<GitStatusResponse>>;
    /** Requested only when a diff is actually on screen — performance rule 5. */
    diff(request: GitDiffRequest): Promise<Result<FileDiff>>;
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
