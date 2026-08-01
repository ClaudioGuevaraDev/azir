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
  ContentSearchResponse,
  ResizeTerminalRequest,
  SaveSettingsRequest,
  SearchContentRequest,
  SearchIndexDeltaEvent,
  SearchIndexEvent,
  SettingsSnapshot,
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

  readonly search: {
    /**
     * Content search. There is no path-search method, and that is the design: the spec requires
     * path search to answer on every keystroke without IPC, so it runs in the renderer against
     * the index delivered by `onIndex`.
     */
    content(request: SearchContentRequest): Promise<Result<ContentSearchResponse>>;
    /** The path index, once main has finished walking the workspace. */
    onIndex(listener: (event: SearchIndexEvent) => void): Unsubscribe;
    /** Incremental updates, so the index tracks what an agent creates and deletes. */
    onIndexDelta(listener: (event: SearchIndexDeltaEvent) => void): Unsubscribe;
  };

  readonly settings: {
    /**
     * The values main loaded and validated at startup, plus any field that fell back.
     *
     * Read once, when the renderer mounts. Settings are not re-read afterwards: the renderer holds
     * the live values from that point on, and the file is only their startup source
     * (docs/architecture.md, Settings).
     */
    load(): Promise<Result<SettingsSnapshot>>;
    /**
     * A patch of whole groups. Fire-and-forget: the write is debounced in main, and a UI that
     * waited for the disk before showing a changed arrangement would feel broken.
     */
    save(request: SaveSettingsRequest): void;
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
