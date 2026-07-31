/**
 * The IPC boundary is total: it returns failures, it never throws.
 *
 * docs/architecture.md requires that external failures become application
 * state, not crashes ("Git failures are application states, not crashes";
 * "The user must always retain a usable application surface when one subsystem
 * fails"). If handlers threw, `ipcRenderer.invoke` would reject and every call
 * site in the effect runner would have to invent its own error message. With a
 * Result the reducer branches on a closed set of codes instead, which is what
 * makes invariant 13 mechanical rather than aspirational.
 */

export const APP_ERROR_CODES = [
  /** The payload failed schema validation at the boundary. */
  'invalid-request',
  /** An unexpected exception inside a handler. Always a bug. */
  'internal',
  /** The request named a workspace session that is no longer active. */
  'stale-session',
  /** The resolved path escaped the active workspace root. */
  'path-outside-workspace',
  /** The target file or directory does not exist. */
  'not-found',
  /** The OS refused access. */
  'permission-denied',
  /** A directory was given where a file was expected, or vice versa. */
  'not-a-file',
  /** The file exceeds the size the viewer will load. */
  'too-large',
  /** The bytes are not decodable as text. */
  'binary-content',
  /** The `git` binary is not on PATH. */
  'git-missing',
  /** The workspace root is not inside a git repository. */
  'not-a-repository',
  /** An external command exceeded its time budget. */
  'timed-out',
  /** A pseudo-terminal could not be started. */
  'pty-failed',
  /** The referenced terminal pane does not exist. */
  'unknown-pane',
  /** The workspace already holds the maximum number of panes. */
  'pane-limit-reached',
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

export interface AppError {
  readonly code: AppErrorCode;
  readonly message: string;
  /** Unredacted technical detail, for logs and the notices panel. */
  readonly detail?: string;
}

export type Result<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: AppError };

export const ok = <T>(value: T): Result<T> => ({ ok: true, value });

export const err = (code: AppErrorCode, message: string, detail?: string): Result<never> =>
  // Written as a branch rather than `{ code, message, detail }` because
  // exactOptionalPropertyTypes forbids assigning `undefined` to an optional
  // property, and an absent key serialises more cleanly over IPC.
  detail === undefined
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, message, detail } };

export const isOk = <T>(result: Result<T>): result is { ok: true; value: T } => result.ok;

/** Turn an unknown thrown value into a string safe to attach as `detail`. */
export const describeError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.stack ?? `${error.name}: ${error.message}`;
  }
  return String(error);
};
