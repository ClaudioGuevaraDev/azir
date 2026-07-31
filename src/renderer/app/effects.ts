import type { WorkspaceSessionId } from '@shared/ipc/contracts';
import type { RequestId } from './state';

/**
 * Effects describe privileged or asynchronous work. They are data, so the
 * reducer can return them without performing them — that is what keeps the
 * reducer pure and testable (docs/architecture.md: "The reducer describes what
 * must happen. It never performs the work itself.").
 *
 * The effect runner in runtime/effectRunner.ts is the only interpreter.
 */
export type Effect =
  | { readonly type: 'workspace/pickFolder' }
  | { readonly type: 'workspace/open'; readonly path: string; readonly requestId: RequestId }
  | { readonly type: 'workspace/close'; readonly sessionId: WorkspaceSessionId };

/**
 * A stable structural key for an effect, used to collapse duplicates produced
 * within a single dispatch burst.
 *
 * Two identical `workspace/pickFolder` effects would open two native dialogs;
 * duplicate git refreshes and PTY resizes are called out explicitly in the
 * performance rules. Deduplication is by exact equality only — near-duplicates
 * (a resize to a different size, a read of a different path) are genuinely
 * different work and must both run.
 */
export const effectKey = (effect: Effect): string => {
  switch (effect.type) {
    case 'workspace/pickFolder':
      return effect.type;
    case 'workspace/open':
      return `${effect.type}|${effect.requestId}|${effect.path}`;
    case 'workspace/close':
      return `${effect.type}|${effect.sessionId}`;
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
