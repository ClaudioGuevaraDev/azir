import type {
  DiffTarget,
  Eol,
  FileDiff,
  GitFileStatus,
  ReadFileResponse,
} from '@shared/ipc/contracts';
import type { AppError } from '@shared/ipc/result';
import { originCaret, type Caret } from './document';
import type { RequestId } from './state';

/**
 * The code viewer's model.
 *
 * docs/architecture.md's shape for this panel, and what each part is defending against:
 *
 *  - **Tabs keyed by path**, never by index, for the same reason repository rows are.
 *  - **A separate viewport per mode.** Switching from code to diff and back must not
 *    lose the reader's place, and the two have unrelated line counts.
 *  - **Both a path and a request id on every response.** Two rapid opens, or a
 *    watcher-triggered reload racing a manual one, must not let the older answer
 *    overwrite the newer.
 *  - **Diffs loaded only when viewed** (performance rule 5) and **background tabs
 *    invalidated rather than eagerly re-read** (rule 6).
 */

export type Loadable<T> =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'error'; readonly error: AppError };

/**
 * A decoded file, split into lines once.
 *
 * The split happens here rather than in the view because it is the expensive part and
 * the view re-renders on every scroll. `eol` and `hadBom` are carried so that editing —
 * which lands in M7 — can write the file back the way it found it instead of turning a
 * one-line change into a whole-file diff.
 */
export interface Document {
  readonly lines: readonly string[];
  readonly eol: Eol;
  readonly hadBom: boolean;
  readonly byteSize: number;
}

export type ViewerMode = 'code' | 'diff';

export interface ViewerTab {
  readonly path: string;
  readonly content: Loadable<Document>;
  readonly diff: Loadable<FileDiff>;
  readonly mode: ViewerMode;
  readonly diffTarget: DiffTarget;
  /** Scroll offset in rows, kept per mode so switching does not lose the place. */
  readonly codeTop: number;
  readonly diffTop: number;
  /**
   * The file changed on disk while this tab was not the active one.
   *
   * Rule 6: invalidate rather than re-read. Reloading every open tab on every watcher
   * batch would read files nobody is looking at — during a checkout, all of them.
   */
  readonly stale: boolean;
  /** Edited and not yet written. */
  readonly dirty: boolean;
  /**
   * The file moved on disk while this tab held unsaved edits.
   *
   * Distinct from `stale`, and the distinction is the point: a stale tab is reloaded when it
   * next becomes visible, but a dirty one must **never** be silently reloaded — that would
   * throw away the user's work without asking. The spec is explicit about it.
   */
  readonly changedOnDisk: boolean;
  readonly caret: Caret;
  readonly save: SaveState;
  readonly contentRequestId: RequestId | null;
  readonly diffRequestId: RequestId | null;
  readonly saveRequestId: RequestId | null;
}

export type SaveState =
  | { readonly status: 'idle' }
  | { readonly status: 'saving' }
  | { readonly status: 'failed'; readonly error: AppError };

export interface ViewerState {
  readonly tabs: readonly ViewerTab[];
  readonly activePath: string | null;
}

export const initialViewerState: ViewerState = { tabs: [], activePath: null };

/** A fixed maximum, so a session of clicking through a tree cannot grow without bound. */
export const MAX_TABS = 12;

export const newTab = (path: string, requestId: RequestId): ViewerTab => ({
  path,
  content: { status: 'loading' },
  diff: { status: 'idle' },
  mode: 'code',
  diffTarget: 'worktree',
  codeTop: 0,
  diffTop: 0,
  stale: false,
  dirty: false,
  changedOnDisk: false,
  caret: originCaret,
  save: { status: 'idle' },
  contentRequestId: requestId,
  diffRequestId: null,
  saveRequestId: null,
});

/** True when any open tab holds unsaved edits. Drives the quit guard. */
export const hasUnsavedWork = (state: ViewerState): boolean => state.tabs.some((tab) => tab.dirty);

export const toDocument = (response: ReadFileResponse): Document => ({
  // `split` on a trailing newline yields a final empty string, which is correct: a file
  // ending in a newline does have an empty last line, and dropping it would make the
  // line count disagree with every other tool.
  lines: response.content
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line)),
  eol: response.eol,
  hadBom: response.hadBom,
  byteSize: response.byteSize,
});

// -------------------------------------------------------------- projections

export const findTab = (state: ViewerState, path: string): ViewerTab | undefined =>
  state.tabs.find((tab) => tab.path === path);

export const activeTab = (state: ViewerState): ViewerTab | undefined =>
  state.activePath === null ? undefined : findTab(state, state.activePath);

/**
 * An untracked file has no diff: `git diff` compares against the index, and the index
 * has never heard of it. Showing an empty diff for a file an agent just created would be
 * the least useful possible answer, so the whole file is projected as additions.
 *
 * Synthesised here rather than by invoking `git diff --no-index` against a null device,
 * which spells that device differently on every platform and costs a second process for
 * content the renderer already has.
 */
export const synthesizeAddedDiff = (
  path: string,
  document: Document,
  target: DiffTarget,
): FileDiff => {
  // A trailing empty line is an artefact of the split, not a line of the file.
  const lines =
    document.lines.length > 1 && document.lines[document.lines.length - 1] === ''
      ? document.lines.slice(0, -1)
      : document.lines;

  if (lines.length === 0) {
    return { path, target, binary: false, hunks: [] };
  }

  return {
    path,
    target,
    binary: false,
    hunks: [
      {
        heading: '',
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: lines.length,
        lines: lines.map((text, index) => ({
          kind: 'add' as const,
          text,
          oldNumber: null,
          newNumber: index + 1,
        })),
      },
    ],
  };
};

/** True when git says the path exists only in the working tree. */
export const isUntracked = (status: GitFileStatus | undefined): boolean =>
  status?.unstaged === 'untracked';

/**
 * A flat row list for the diff view, so it can be virtualised the same way the tree and
 * the code view are.
 *
 * Hunk headers become rows of their own rather than sticky elements outside the list:
 * mixing two element types with different heights in one scroll container is what makes
 * fixed-height windowing stop working.
 */
export type DiffRow =
  | {
      readonly kind: 'hunk';
      readonly key: string;
      readonly heading: string;
      readonly label: string;
    }
  | {
      readonly kind: 'line';
      readonly key: string;
      readonly line: FileDiff['hunks'][number]['lines'][number];
    };

export const projectDiffRows = (diff: FileDiff): readonly DiffRow[] => {
  const rows: DiffRow[] = [];

  diff.hunks.forEach((hunk, hunkIndex) => {
    rows.push({
      kind: 'hunk',
      key: `h${hunkIndex}`,
      heading: hunk.heading,
      label: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
    });
    hunk.lines.forEach((line, lineIndex) => {
      rows.push({ kind: 'line', key: `h${hunkIndex}l${lineIndex}`, line });
    });
  });

  return rows;
};

export const countDiffChanges = (diff: FileDiff): { added: number; removed: number } => {
  let added = 0;
  let removed = 0;
  for (const hunk of diff.hunks) {
    for (const line of hunk.lines) {
      if (line.kind === 'add') {
        added += 1;
      } else if (line.kind === 'remove') {
        removed += 1;
      }
    }
  }
  return { added, removed };
};
