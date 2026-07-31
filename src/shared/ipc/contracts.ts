import { z } from 'zod';

/**
 * Request schemas and response types for every channel.
 *
 * Requests are described as zod schemas rather than bare TypeScript types
 * because the main process must validate them at runtime — a compromised or
 * buggy renderer can send anything (docs/architecture.md, Security: "validate
 * every IPC payload"). Response types stay plain: they are produced by trusted
 * code, so only their shape matters.
 */

/**
 * Spelled out rather than reused from `NodeJS.Platform`, because src/shared is
 * compiled into the renderer too and the renderer has no Node typings — that
 * omission is the type-level half of the boundary, so shared has to describe
 * platform-shaped values itself.
 */
export type Platform =
  | 'aix'
  | 'android'
  | 'cygwin'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'netbsd'
  | 'openbsd'
  | 'sunos'
  | 'win32';

/**
 * Identifies one workspace lifetime. Minted in the **main process**, never by
 * the renderer.
 *
 * docs/architecture.md requires that opening a second folder disposes the first
 * completely and that "pending requests are ignored", and separately that file
 * operations stay inside the active workspace. Both fall out of one primitive:
 * every path-scoped request carries the session it belongs to, main resolves
 * paths against its *own* record of that session's root rather than trusting the
 * renderer's claim, and a request naming a dead session is refused with
 * `stale-session`. Disposal then becomes a single lookup rather than a sweep.
 */
export type WorkspaceSessionId = number;

/** For channels that take no arguments. `invoke(channel)` sends `undefined`. */
export const noRequestSchema = z.undefined();

// ---------------------------------------------------------------- app:ping

export const pingRequestSchema = z.object({
  /** Echoed back so the caller can prove the response is its own. */
  nonce: z.string().min(1).max(64),
});

export type PingRequest = z.infer<typeof pingRequestSchema>;

export interface PingResponse {
  readonly nonce: string;
  readonly electron: string;
  readonly chrome: string;
  readonly node: string;
  readonly platform: Platform;
}

// ----------------------------------------------------------- workspace:*

export type PickFolderResponse = string | null;

/**
 * The one place an absolute path legitimately crosses IPC.
 *
 * Everywhere else, requests carry a session id plus a workspace-relative POSIX
 * path, because main must not trust a renderer-supplied absolute path. Opening a
 * workspace is the exception by definition: there is no root to be relative to
 * yet. Main still validates that the path exists and is a directory before it
 * mints anything.
 */
export const workspaceOpenRequestSchema = z.object({
  path: z
    .string()
    .min(1)
    .max(4096)
    .refine((value) => !value.includes('\0'), {
      message: 'path must not contain NUL bytes',
    }),
});

export type WorkspaceOpenRequest = z.infer<typeof workspaceOpenRequestSchema>;

export interface WorkspaceInfo {
  readonly sessionId: WorkspaceSessionId;
  /** Normalised absolute path. For display and for the window title only. */
  readonly root: string;
  /** Last path segment, or the drive/volume when the root has no segments. */
  readonly name: string;
}

export const workspaceCloseRequestSchema = z.object({
  sessionId: z.number().int().nonnegative(),
});

export type WorkspaceCloseRequest = z.infer<typeof workspaceCloseRequestSchema>;

export interface WorkspaceCloseResponse {
  /** False when the session was already gone — closing is idempotent. */
  readonly closed: boolean;
}

// ---------------------------------------------------------------- files:*

/**
 * A workspace-relative POSIX path. The empty string is the workspace root.
 *
 * POSIX rather than native so the same string means the same node on every
 * platform, and relative rather than absolute so main always resolves it against
 * the root it recorded for the session (see `WorkspaceSessionId`).
 */
export const relativePathSchema = z
  .string()
  .max(4096)
  .refine((value) => !value.includes('\0'), { message: 'path must not contain NUL bytes' });

export const listDirectoryRequestSchema = z.object({
  sessionId: z.number().int().nonnegative(),
  path: relativePathSchema,
});

export type ListDirectoryRequest = z.infer<typeof listDirectoryRequestSchema>;

export type FileKind = 'file' | 'directory';

export interface DirectoryEntry {
  /** Workspace-relative POSIX path, so it is usable as a stable identity. */
  readonly path: string;
  readonly name: string;
  readonly kind: FileKind;
}

export interface ListDirectoryResponse {
  /** Echoed back so the reducer can route the response to the right node. */
  readonly path: string;
  readonly entries: readonly DirectoryEntry[];
}

// ------------------------------------------------------------------ git:*

/**
 * What happened to one file, in one of the two places git tracks it.
 *
 * Split into `staged` and `unstaged` rather than collapsed into a single status
 * because a partially staged file is genuinely in two states at once, and the
 * viewer has to be able to show either side.
 */
export type GitChangeKind =
  | 'added'
  | 'modified'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'type-changed'
  | 'untracked'
  | 'ignored';

export interface GitFileStatus {
  /** Workspace-relative POSIX path, matching the repository tree's identity. */
  readonly path: string;
  /** The change in the index, or null when the index matches HEAD. */
  readonly staged: GitChangeKind | null;
  /** The change in the working tree, or null when it matches the index. */
  readonly unstaged: GitChangeKind | null;
  /** Where a renamed or copied file came from. */
  readonly originalPath?: string;
  /** An unmerged path. Rendered distinctly because it needs a decision, not review. */
  readonly conflicted: boolean;
}

export interface GitBranchInfo {
  /** Null when HEAD is detached. */
  readonly head: string | null;
  /** Null in a repository with no commits yet. */
  readonly commit: string | null;
  readonly upstream: string | null;
  readonly ahead: number;
  readonly behind: number;
  readonly detached: boolean;
}

export const gitStatusRequestSchema = z.object({
  sessionId: z.number().int().nonnegative(),
});

export type GitStatusRequest = z.infer<typeof gitStatusRequestSchema>;

export interface GitStatusResponse {
  readonly branch: GitBranchInfo;
  readonly files: readonly GitFileStatus[];
}

// ------------------------------------------------------------------- fs:*

export type FsEventKind = 'add' | 'change' | 'unlink' | 'addDir' | 'unlinkDir';

/**
 * A coalesced set of filesystem changes.
 *
 * Already translated from raw events into consequences, so the reducer never has to
 * know filesystem semantics: an add or a delete makes a *directory* stale, a write
 * makes a *file* stale, and anything under the watched `.git` paths is just one bit.
 */
export interface FsChangeBatch {
  readonly sessionId: WorkspaceSessionId;
  /** Directories whose listing is stale, workspace-relative POSIX. */
  readonly directories: readonly string[];
  /** Files whose contents changed. */
  readonly files: readonly string[];
  /** A commit, checkout, stage or branch switch happened. */
  readonly gitDirty: boolean;
  /**
   * The batch exceeded its path budget, so the lists are incomplete.
   *
   * A change set this large is a checkout or an install rather than an edit, and the
   * right response is to refresh what is on screen instead of trying to apply
   * thousands of individual paths.
   */
  readonly truncated: boolean;
}

// ------------------------------------------------------------- terminal:*

/**
 * Identifies one terminal pane. Stable for the pane's whole life, and **never
 * reused** — that is what stops late PTY output from a killed pane being
 * delivered to a new pane that happens to occupy the same visual slot
 * (docs/architecture.md, Terminal identities).
 */
export type TerminalPaneId = string;

/** Which shell to start. `default` lets main pick per platform. */
export const shellKindSchema = z.enum(['default', 'powershell', 'pwsh', 'cmd', 'bash', 'zsh']);

export type ShellKind = z.infer<typeof shellKindSchema>;

const sessionScoped = {
  sessionId: z.number().int().nonnegative(),
  paneId: z.string().min(1).max(64),
};

/**
 * Note what is absent: `cwd`. The working directory is derived in main from the
 * session's recorded root, so the renderer cannot start a shell outside the
 * workspace.
 */
export const createTerminalRequestSchema = z.object({
  ...sessionScoped,
  shell: shellKindSchema.default('default'),
});

export type CreateTerminalRequest = z.input<typeof createTerminalRequestSchema>;

export interface CreateTerminalResponse {
  readonly paneId: TerminalPaneId;
  /** The executable actually started, for the pane title and for diagnostics. */
  readonly shellPath: string;
  readonly cwd: string;
  readonly pid: number;
}

export const writeTerminalRequestSchema = z.object({
  ...sessionScoped,
  // Bounded because a paste is a single write and an unbounded one would let the
  // renderer hand main an arbitrarily large string.
  data: z.string().max(1_048_576),
});

export type WriteTerminalRequest = z.infer<typeof writeTerminalRequestSchema>;

export const resizeTerminalRequestSchema = z.object({
  ...sessionScoped,
  cols: z.number().int().min(1).max(2000),
  rows: z.number().int().min(1).max(2000),
});

export type ResizeTerminalRequest = z.infer<typeof resizeTerminalRequestSchema>;

export const killTerminalRequestSchema = z.object(sessionScoped);

export type KillTerminalRequest = z.infer<typeof killTerminalRequestSchema>;

export interface TerminalDataEvent {
  readonly sessionId: WorkspaceSessionId;
  readonly paneId: TerminalPaneId;
  readonly data: string;
}

export interface TerminalExitEvent {
  readonly sessionId: WorkspaceSessionId;
  readonly paneId: TerminalPaneId;
  readonly exitCode: number | null;
  readonly signal?: number;
}
