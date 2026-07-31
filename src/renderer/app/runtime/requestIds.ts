import type { RequestId } from '../state';

/**
 * Monotonic request ids, minted at the dispatch edge.
 *
 * The reducer must stay pure (docs/architecture.md invariant 2), so it cannot
 * call this — a counter or `Math.random()` inside a reducer makes the same
 * (state, action) pair produce different output and breaks snapshot tests.
 *
 * The rule for reviewers: `nextRequestId` may be called from `actions.ts` and
 * `runtime/*` only, never from anything under `reducer/`.
 *
 * Ids are strings rather than numbers so they are obviously opaque at call sites
 * and can never be confused with an index or a session id.
 */
let counter = 0;

export const nextRequestId = (): RequestId => {
  counter += 1;
  return `r${counter}`;
};

/** Test-only. Keeps ids readable and assertions stable across test files. */
export const resetRequestIds = (): void => {
  counter = 0;
};
