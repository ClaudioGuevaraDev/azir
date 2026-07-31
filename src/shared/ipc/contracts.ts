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

export const pingRequestSchema = z.object({
  /** Echoed back so the caller can prove the response is its own. */
  nonce: z.string().min(1).max(64),
});

export type PingRequest = z.infer<typeof pingRequestSchema>;

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

export interface PingResponse {
  readonly nonce: string;
  readonly electron: string;
  readonly chrome: string;
  readonly node: string;
  readonly platform: Platform;
}
