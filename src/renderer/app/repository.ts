import type { DirectoryEntry, FileKind } from '@shared/ipc/contracts';
import type { AppError } from '@shared/ipc/result';
import type { RequestId } from './state';

/**
 * The repository model.
 *
 * docs/architecture.md is specific here: there is no separate explorer panel and
 * git-changes panel. The filesystem scan and git status are combined into **one**
 * projection, which is then viewed as a tree or as a flat list of changes. Keeping
 * them as one model is what stops the two views from disagreeing about what exists.
 *
 * Identity is the workspace-relative POSIX path. Row indexes are never identities:
 * they change whenever a directory expands, and a selection keyed on one would jump
 * to a different file every time the tree moved.
 */

export interface FileNode {
  readonly path: string;
  readonly name: string;
  readonly kind: FileKind;
  /**
   * True for a node git knows about but the filesystem does not — a deleted file
   * that still needs to be reviewable. The spec calls these virtual nodes.
   */
  readonly virtual?: boolean;
}

/**
 * Lazy loading made explicit, exactly as the spec models it. A directory that has
 * never been opened is distinguishable from one that is opening, one that is open,
 * and one that could not be read — so the UI can render each honestly instead of
 * showing an empty folder for all four.
 */
export type DirectoryChildren =
  | { readonly status: 'unloaded' }
  | { readonly status: 'loading' }
  | { readonly status: 'loaded'; readonly children: readonly FileNode[] }
  | { readonly status: 'failed'; readonly error: AppError };

export type RepositoryView = 'tree' | 'changes';

export interface RepositoryState {
  /** Keyed by directory path; the root is the empty string. */
  readonly directories: Readonly<Record<string, DirectoryChildren>>;
  /**
   * Which directory loads are in flight, keyed by path.
   *
   * Kept separate from `directories` so a refresh of an already-loaded directory
   * keeps showing its current children instead of blanking to a spinner, while
   * still letting a superseded response be recognised and dropped.
   */
  readonly pending: Readonly<Record<string, RequestId>>;
  readonly expanded: Readonly<Record<string, true>>;
  readonly selectedPath: string | null;
  readonly view: RepositoryView;
}

export const initialRepositoryState: RepositoryState = {
  directories: {},
  pending: {},
  expanded: {},
  selectedPath: null,
  view: 'tree',
};

export const toFileNode = (entry: DirectoryEntry): FileNode => ({
  path: entry.path,
  name: entry.name,
  kind: entry.kind,
});

// ------------------------------------------------------------------- rows

/**
 * One line in the panel. Flattened from the tree so the list can be virtualised —
 * the spec requires virtualisation for large lists, and that needs a flat array of
 * fixed-height rows.
 */
export interface RepositoryRow {
  readonly path: string;
  readonly name: string;
  readonly kind: FileKind;
  readonly depth: number;
  readonly expanded: boolean;
  /** Lets the row render a spinner, a chevron or an error marker. */
  readonly childrenStatus: DirectoryChildren['status'];
  readonly virtual: boolean;
}

const ROOT = '';

/**
 * Flattens the loaded, expanded part of the tree into rows.
 *
 * Only expanded directories contribute children, which is what makes the cost
 * proportional to what is visible rather than to the size of the repository.
 */
export const projectRows = (state: RepositoryState): readonly RepositoryRow[] => {
  const rows: RepositoryRow[] = [];

  const walk = (directoryPath: string, depth: number): void => {
    const children = state.directories[directoryPath];
    if (children?.status !== 'loaded') {
      return;
    }

    for (const node of children.children) {
      const isDirectory = node.kind === 'directory';
      const expanded = isDirectory && state.expanded[node.path] === true;
      const own = state.directories[node.path];

      rows.push({
        path: node.path,
        name: node.name,
        kind: node.kind,
        depth,
        expanded,
        childrenStatus: isDirectory ? (own?.status ?? 'unloaded') : 'loaded',
        virtual: node.virtual === true,
      });

      if (expanded) {
        walk(node.path, depth + 1);
      }
    }
  };

  walk(ROOT, 0);
  return rows;
};

/**
 * Memoised on the three fields the projection reads.
 *
 * Performance rule 3 asks for memoised projections. The keys are compared by
 * identity, which works because the slice reducer preserves identity for anything
 * it did not change — so typing in the terminal or opening a tab does not rebuild
 * the tree.
 */
let cachedDirectories: RepositoryState['directories'] | undefined;
let cachedExpanded: RepositoryState['expanded'] | undefined;
let cachedRows: readonly RepositoryRow[] = [];

export const selectRepositoryRows = (state: RepositoryState): readonly RepositoryRow[] => {
  if (state.directories === cachedDirectories && state.expanded === cachedExpanded) {
    return cachedRows;
  }
  cachedDirectories = state.directories;
  cachedExpanded = state.expanded;
  cachedRows = projectRows(state);
  return cachedRows;
};

/** Test seam: the cache is module-level, so it has to be clearable. */
export const resetRepositoryProjectionCache = (): void => {
  cachedDirectories = undefined;
  cachedExpanded = undefined;
  cachedRows = [];
};

/** The directory a path lives in, or the root. */
export const parentOf = (relativePosix: string): string => {
  const index = relativePosix.lastIndexOf('/');
  return index === -1 ? ROOT : relativePosix.slice(0, index);
};

/** Every ancestor of a path, root first. Used to reveal a file in the tree. */
export const ancestorsOf = (relativePosix: string): readonly string[] => {
  if (relativePosix === '' || !relativePosix.includes('/')) {
    return [ROOT];
  }
  const segments = relativePosix.split('/');
  segments.pop();
  const ancestors: string[] = [ROOT];
  let current = '';
  for (const segment of segments) {
    current = current === '' ? segment : `${current}/${segment}`;
    ancestors.push(current);
  }
  return ancestors;
};

/**
 * True when the path still exists in the loaded part of the tree.
 *
 * The spec requires selection to survive a refresh when the selected path still
 * exists — and only then. A directory that has not been loaded counts as "unknown",
 * not "gone", so a selection deep in a collapsed subtree is not discarded.
 */
export const pathStillExists = (state: RepositoryState, relativePosix: string): boolean => {
  const parent = parentOf(relativePosix);
  const children = state.directories[parent];
  if (children === undefined || children.status !== 'loaded') {
    return true;
  }
  return children.children.some((node) => node.path === relativePosix);
};
