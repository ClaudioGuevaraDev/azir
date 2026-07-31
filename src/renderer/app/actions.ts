import type { WorkspaceInfo, WorkspaceSessionId } from '@shared/ipc/contracts';
import type { AppError } from '@shared/ipc/result';
import { nextRequestId } from './runtime/requestIds';
import type { RequestId, Severity } from './state';

/**
 * Actions describe user intent or completed external work.
 *
 * They carry facts, never callbacks — an action holding a function cannot be
 * logged, replayed or compared, and it lets a component smuggle behaviour past
 * the reducer.
 *
 * Note what is *absent*: there is no `terminal/output`. docs/architecture.md
 * lists one, but dispatching an action per PTY chunk contradicts its own
 * performance rules 1–2 and the statement that xterm.js is the terminal's
 * presentation buffer. Terminal bytes travel a side channel instead; see
 * src/renderer/terminal/registry.ts. The action is not left in the union
 * unused, because an unused-but-documented action gets used.
 */
export type Action =
  // ---- workspace
  | { readonly type: 'workspace/openRequested' }
  | { readonly type: 'workspace/pickCancelled' }
  | { readonly type: 'workspace/pickFailed'; readonly error: AppError }
  | { readonly type: 'workspace/pathChosen'; readonly path: string; readonly requestId: RequestId }
  | {
      readonly type: 'workspace/opened';
      readonly requestId: RequestId;
      readonly info: WorkspaceInfo;
    }
  | {
      readonly type: 'workspace/openFailed';
      readonly requestId: RequestId;
      readonly error: AppError;
    }
  | { readonly type: 'workspace/closeRequested' }
  | { readonly type: 'workspace/closed'; readonly sessionId: WorkspaceSessionId }
  // ---- notices
  | {
      readonly type: 'notice/raised';
      readonly severity: Severity;
      readonly message: string;
      readonly detail?: string;
    }
  | { readonly type: 'notice/dismissed'; readonly id: string };

/**
 * Action creators exist only where an id has to be minted. Everything else is
 * constructed inline at the dispatch site, which keeps the wiring readable.
 *
 * `nextRequestId` may be called here and in runtime/*, never under reducer/.
 */
export const pathChosen = (path: string): Action => ({
  type: 'workspace/pathChosen',
  path,
  requestId: nextRequestId(),
});
