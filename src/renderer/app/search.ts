import type { ContentMatch } from '@shared/ipc/contracts';
import type { AppError } from '@shared/ipc/result';
import type { RequestId } from './state';

/**
 * Search state, and the path matcher that runs against it.
 *
 * docs/architecture.md splits search in two, and the split is about where the work happens:
 * "Path search operates on an in-memory path index and should respond on every keystroke without
 * IPC. Content search requires filesystem access and runs in the main process."
 *
 * So `matchPaths` below is the entire path-search implementation, and it lives in the renderer on
 * purpose. Content search is one effect and a `requestId` gate.
 */

export type SearchMode = 'path' | 'content';

/**
 * The path index the renderer holds.
 *
 * `building` is a distinct state rather than an empty index, because the two need different words
 * on screen: "no matches" and "not indexed yet" are opposite answers, and showing the first while
 * the second is true tells the user their file does not exist.
 */
export type PathIndexState =
  | { readonly status: 'idle' }
  | { readonly status: 'building' }
  | {
      readonly status: 'ready';
      readonly paths: readonly string[];
      /** The walk hit its limit, so a path genuinely may be missing. Said, not hidden. */
      readonly truncated: boolean;
    };

export type ContentResultsState =
  | { readonly status: 'idle' }
  | { readonly status: 'searching' }
  | {
      readonly status: 'ready';
      readonly matches: readonly ContentMatch[];
      readonly truncated: boolean;
      readonly filesScanned: number;
    }
  | { readonly status: 'error'; readonly error: AppError };

export interface SearchState {
  readonly mode: SearchMode;
  readonly query: string;
  readonly index: PathIndexState;
  readonly content: ContentResultsState;
  /**
   * The content search in flight.
   *
   * "Latest query wins" needs this on both sides: main abandons the superseded *work*, and the
   * reducer drops the superseded *answer*. Neither alone is enough — an abandoned search can
   * still have a result already in the IPC queue.
   */
  readonly contentRequestId: RequestId | null;
}

export const initialSearchState: SearchState = {
  mode: 'path',
  query: '',
  index: { status: 'idle' },
  content: { status: 'idle' },
  contentRequestId: null,
};

/** How many path hits are kept. More than fits on screen, few enough to render instantly. */
export const MAX_PATH_RESULTS = 200;

export interface PathHit {
  readonly path: string;
  /** Lower is better. Only meaningful for ordering within one query. */
  readonly score: number;
}

/**
 * Subsequence matching, ranked.
 *
 * Characters of the query must appear in the path in order but need not be adjacent, which is how
 * people type a path they half remember: `apprct` finds `src/renderer/app/react.tsx`, and `ovh`
 * finds `src/renderer/overlays/OverlayHost.tsx`.
 *
 * Ranking is deliberately simple and explainable rather than clever:
 *
 *  - a match inside the file name beats one spread across directories, because the name is what
 *    the user was thinking of;
 *  - a tighter span beats a looser one;
 *  - a shorter path breaks ties, so `src/app.ts` sorts above `src/vendor/legacy/app.ts`.
 *
 * A fuzzy matcher that cannot be explained is one nobody can fix when it puts the wrong file
 * first, and putting the wrong file first is the only way this feature fails.
 */
export const matchPaths = (
  paths: readonly string[],
  query: string,
  limit = MAX_PATH_RESULTS,
): readonly PathHit[] => {
  const needle = query.trim().toLowerCase();
  if (needle === '') {
    return [];
  }

  const hits: PathHit[] = [];
  for (const candidate of paths) {
    const score = scorePath(candidate, needle);
    if (score !== null) {
      hits.push({ path: candidate, score });
    }
  }

  hits.sort((a, b) => a.score - b.score || a.path.length - b.path.length);
  return hits.slice(0, limit);
};

/**
 * The span of the leftmost subsequence match, or `null` when there is none.
 *
 * Leftmost-greedy rather than optimal. Finding the genuinely tightest window would need a second
 * pass, and the case it improves — a query whose letters also appear scattered earlier — is
 * handled by trying the file name on its own first, which is where the improvement actually
 * matters.
 */
const spanOf = (haystack: string, needle: string): number | null => {
  let index = 0;
  let first = -1;
  let last = -1;
  for (let position = 0; position < haystack.length && index < needle.length; position += 1) {
    if (haystack[position] === needle[index]) {
      if (first === -1) {
        first = position;
      }
      last = position;
      index += 1;
    }
  }
  return index < needle.length ? null : last - first + 1;
};

/** `null` when the query is not a subsequence of the path. */
const scorePath = (candidate: string, needle: string): number | null => {
  const haystack = candidate.toLowerCase();
  const name = haystack.slice(haystack.lastIndexOf('/') + 1);

  /*
   * The file name is tried on its own before the whole path, and that ordering is the fix for a
   * real misranking: matching greedily across the full path lets an incidental letter in a
   * directory start the match early and inflate the span. Searching `index` would rank
   * `src/renderer/app/reducer/index.ts` above `src/main/index.ts`, because the `i` in `main`
   * dragged the second one's match out to nine characters. Scoring the name first makes both
   * spans 5 and lets the tie-break — the shorter path — decide, which is the answer a person
   * expects.
   */
  const inName = spanOf(name, needle);
  if (inName !== null) {
    return inName;
  }

  const acrossPath = spanOf(haystack, needle);
  // A run of directories that happens to contain the letters always scores worse than any file
  // name that contains them, however tight the run.
  return acrossPath === null ? null : 1000 + acrossPath;
};
