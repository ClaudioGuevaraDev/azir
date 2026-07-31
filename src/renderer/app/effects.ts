import type { DiffTarget, TerminalPaneId, WorkspaceSessionId } from '@shared/ipc/contracts';
import type { RequestId } from './state';

/**
 * Effects describe privileged or asynchronous work. They are data, so the reducer
 * can return them without performing them — that is what keeps the reducer pure and
 * testable (docs/architecture.md: "The reducer describes what must happen. It never
 * performs the work itself.").
 *
 * The effect runner in runtime/effectRunner.ts is the only interpreter.
 *
 * `terminal/write` and `terminal/resize` from the spec's effect list are absent on
 * purpose: they are continuous, carry no application state, and go straight from
 * the terminal controller to the bridge. Routing a keystroke through the reducer
 * would make every character a state transition.
 */
export type Effect =
  | { readonly type: 'workspace/pickFolder' }
  | { readonly type: 'workspace/open'; readonly path: string; readonly requestId: RequestId }
  | { readonly type: 'workspace/close'; readonly sessionId: WorkspaceSessionId }
  | {
      readonly type: 'repository/listDirectory';
      readonly sessionId: WorkspaceSessionId;
      readonly path: string;
      readonly requestId: RequestId;
    }
  | {
      readonly type: 'git/status';
      readonly sessionId: WorkspaceSessionId;
      readonly requestId: RequestId;
    }
  | {
      readonly type: 'viewer/readFile';
      readonly sessionId: WorkspaceSessionId;
      readonly path: string;
      readonly requestId: RequestId;
    }
  | {
      readonly type: 'viewer/readDiff';
      readonly sessionId: WorkspaceSessionId;
      readonly path: string;
      readonly target: DiffTarget;
      readonly requestId: RequestId;
    }
  | {
      readonly type: 'terminal/create';
      readonly sessionId: WorkspaceSessionId;
      readonly paneId: TerminalPaneId;
    }
  | {
      readonly type: 'terminal/kill';
      readonly sessionId: WorkspaceSessionId;
      readonly paneId: TerminalPaneId;
    };

/**
 * A stable structural key for an effect, used to collapse duplicates produced
 * within a single dispatch burst.
 *
 * Two identical `workspace/pickFolder` effects would open two native dialogs, and
 * two identical `terminal/create` effects would try to spawn the same pane twice.
 * Deduplication is by exact equality only — near-duplicates (a different path, a
 * different pane) are genuinely different work and must both run.
 */
export const effectKey = (effect: Effect): string => {
  switch (effect.type) {
    case 'workspace/pickFolder':
      return effect.type;
    case 'workspace/open':
      return `${effect.type}|${effect.requestId}|${effect.path}`;
    case 'workspace/close':
      return `${effect.type}|${effect.sessionId}`;
    case 'repository/listDirectory':
      // Keyed without the request id: two loads of the same directory queued in one
      // burst are the same work, and issuing both would let the slower one overwrite
      // the faster.
      return `${effect.type}|${effect.sessionId}|${effect.path}`;
    case 'git/status':
      // Performance rule 9, at the effect layer. Main's bounded scheduler coalesces
      // again, which covers refreshes arriving in separate bursts.
      return `${effect.type}|${effect.sessionId}`;
    case 'viewer/readFile':
      return `${effect.type}|${effect.sessionId}|${effect.path}`;
    case 'viewer/readDiff':
      // The target is part of the key: the staged and worktree diffs of the same file
      // are different content, and collapsing them would show one for the other.
      return `${effect.type}|${effect.sessionId}|${effect.target}|${effect.path}`;
    case 'terminal/create':
    case 'terminal/kill':
      return `${effect.type}|${effect.sessionId}|${effect.paneId}`;
  }
};

export const dedupeEffects = (effects: readonly Effect[]): Effect[] => {
  if (effects.length < 2) {
    return [...effects];
  }
  const seen = new Set<string>();
  const result: Effect[] = [];
  for (const effect of effects) {
    const key = effectKey(effect);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(effect);
  }
  return result;
};
