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
