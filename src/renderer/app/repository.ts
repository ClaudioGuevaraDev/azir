import type { DirectoryEntry, FileKind, GitBranchInfo, GitFileStatus } from '@shared/ipc/contracts';
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

/**
 * Git's contribution to the projection.
 *
 * `unavailable` is distinct from `error`: no git binary at all is a permanent
 * condition for the session and the UI should stop offering to retry, while a
 * timeout or a busy index is worth another attempt. The spec is explicit that "a
 * missing git binary must not disable the file browser", which is why this lives
 * alongside the tree rather than gating it.
 */
export type GitState =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly branch: GitBranchInfo;
      readonly byPath: Readonly<Record<string, GitFileStatus>>;
      readonly changed: readonly GitFileStatus[];
    }
  | { readonly status: 'unavailable'; readonly error: AppError }
  | { readonly status: 'error'; readonly error: AppError };

export interface RepositoryState {
  /** Keyed by directory path; the root is the empty string. */
  readonly directories: Readonly<Record<string, DirectoryChildren>>;
  readonly git: GitState;
  /** In-flight git refresh, for the same staleness reason as `pending`. */
  readonly gitRequestId: RequestId | null;
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
  git: { status: 'idle' },
  gitRequestId: null,
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
  /** Git's view of this exact path, when it has one. */
  readonly git?: GitFileStatus;
  /**
   * True when a collapsed directory contains changes.
   *
   * Without this, an agent's edit three levels down is invisible until the user
   * happens to expand the right folders — which defeats the point of a supervision
   * tool. It is computed from the change list rather than by walking the tree,
   * because the tree below a collapsed node has not been read.
   */
  readonly containsChanges?: boolean;
}

const ROOT = '';

/**
 * Every directory that has a change somewhere beneath it.
 *
 * Derived from the flat change list, so it works for parts of the tree that have
 * never been read.
 */
const changedAncestors = (state: RepositoryState): ReadonlySet<string> => {
  const dirty = new Set<string>();
  if (state.git.status !== 'ready') {
    return dirty;
  }
  for (const file of state.git.changed) {
    let parent = parentOf(file.path);
    // Walks up rather than down, so cost is proportional to the number of changes,
    // not to the size of the repository.
    while (parent !== ROOT && !dirty.has(parent)) {
      dirty.add(parent);
      parent = parentOf(parent);
    }
  }
  return dirty;
};

const isDeletion = (status: GitFileStatus): boolean =>
  status.unstaged === 'deleted' || status.staged === 'deleted';

/**
 * Deleted files, grouped by the directory they used to live in.
 *
 * The spec calls these virtual nodes: git knows about them, the filesystem does not,
 * and they still have to be reviewable. For a tool whose whole purpose is supervising
 * an agent, a file the agent deleted is one of the most important things to surface —
 * and it is precisely the thing a filesystem scan can never report.
 *
 * Rename *sources* are deliberately excluded. `git mv a b` reports one change on `b`
 * carrying `originalPath: a`; adding a second node for `a` would double-count the same
 * change, and the badge on `b` already says where it came from.
 */
const deletionsByParent = (state: RepositoryState): ReadonlyMap<string, readonly FileNode[]> => {
  const byParent = new Map<string, FileNode[]>();
  if (state.git.status !== 'ready') {
    return byParent;
  }

  for (const file of state.git.changed) {
    if (!isDeletion(file)) {
      continue;
    }
    const parent = parentOf(file.path);
    const siblings = byParent.get(parent) ?? [];
    siblings.push({
      path: file.path,
      name: file.path.split('/').pop() ?? file.path,
      kind: 'file',
      virtual: true,
    });
    byParent.set(parent, siblings);
  }

  return byParent;
};

/**
 * Flattens the loaded, expanded part of the tree into rows, merging git's status in
 * as it goes.
 *
 * Only expanded directories contribute children, which is what makes the cost
 * proportional to what is visible rather than to the size of the repository.
 */
export const projectRows = (state: RepositoryState): readonly RepositoryRow[] => {
  const rows: RepositoryRow[] = [];
  const byPath = state.git.status === 'ready' ? state.git.byPath : undefined;
  const dirtyDirectories = changedAncestors(state);
  const deletions = deletionsByParent(state);

  const walk = (directoryPath: string, depth: number): void => {
    const children = state.directories[directoryPath];
    if (children?.status !== 'loaded') {
      return;
    }

    const emit = (node: FileNode): void => {
      const isDirectory = node.kind === 'directory';
      const expanded = isDirectory && state.expanded[node.path] === true;
      const own = state.directories[node.path];
      const git = byPath?.[node.path];

      rows.push({
        path: node.path,
        name: node.name,
        kind: node.kind,
        depth,
        expanded,
        childrenStatus: isDirectory ? (own?.status ?? 'unloaded') : 'loaded',
        virtual: node.virtual === true,
        ...(git === undefined ? {} : { git }),
        ...(isDirectory && dirtyDirectories.has(node.path) ? { containsChanges: true } : {}),
      });

      if (expanded) {
        walk(node.path, depth + 1);
      }
    };

    const present = new Set<string>();
    for (const node of children.children) {
      present.add(node.path);
      emit(node);
    }

    // Appended after the real entries rather than merged into sorted position: the
    // scanner owns the ordering, and duplicating its comparator here is how the two
    // would eventually drift apart. Grouping deletions at the end of their folder also
    // reads better than scattering ghosts through the list.
    for (const node of deletions.get(directoryPath) ?? []) {
      // `git rm --cached` leaves the file on disk while marking it deleted in the
      // index, so it can legitimately already be present.
      if (!present.has(node.path)) {
        emit(node);
      }
    }
  };

  walk(ROOT, 0);
  return rows;
};

/**
 * The `changes` projection: git's change list, as flat rows.
 *
 * The same model as the tree, viewed differently — which is the point of combining
 * the two sources rather than keeping an explorer and a git panel that can disagree.
 * Deleted files appear here even though the filesystem no longer has them.
 */
export const projectChangeRows = (state: RepositoryState): readonly RepositoryRow[] => {
  if (state.git.status !== 'ready') {
    return [];
  }
  return state.git.changed.map((file) => ({
    path: file.path,
    name: file.path,
    kind: 'file' as const,
    depth: 0,
    expanded: false,
    childrenStatus: 'loaded' as const,
    virtual: file.staged === 'deleted' || file.unstaged === 'deleted',
    git: file,
  }));
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
let cachedGit: RepositoryState['git'] | undefined;
let cachedView: RepositoryView | undefined;
let cachedRows: readonly RepositoryRow[] = [];

export const selectRepositoryRows = (state: RepositoryState): readonly RepositoryRow[] => {
  if (
    state.directories === cachedDirectories &&
    state.expanded === cachedExpanded &&
    state.git === cachedGit &&
    state.view === cachedView
  ) {
    return cachedRows;
  }
  cachedDirectories = state.directories;
  cachedExpanded = state.expanded;
  cachedGit = state.git;
  cachedView = state.view;
  cachedRows = state.view === 'changes' ? projectChangeRows(state) : projectRows(state);
  return cachedRows;
};

/** Test seam: the cache is module-level, so it has to be clearable. */
export const resetRepositoryProjectionCache = (): void => {
  cachedDirectories = undefined;
  cachedExpanded = undefined;
  cachedGit = undefined;
  cachedView = undefined;
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
