import { beforeEach, describe, expect, it } from 'vitest';
import {
  ancestorsOf,
  initialRepositoryState,
  parentOf,
  pathStillExists,
  projectRows,
  resetRepositoryProjectionCache,
  selectRepositoryRows,
  type FileNode,
  type RepositoryState,
} from './repository';

const node = (path: string, kind: FileNode['kind'] = 'file'): FileNode => ({
  path,
  name: path.split('/').pop() ?? path,
  kind,
});

/**
 * A three-level tree:
 *   src/            (directory, loaded)
 *     app/          (directory, loaded)
 *       store.ts
 *     index.ts
 *   package.json
 */
const tree: RepositoryState = {
  ...initialRepositoryState,
  directories: {
    '': { status: 'loaded', children: [node('src', 'directory'), node('package.json')] },
    src: { status: 'loaded', children: [node('src/app', 'directory'), node('src/index.ts')] },
    'src/app': { status: 'loaded', children: [node('src/app/store.ts')] },
  },
};

const expandedWith = (...paths: string[]): RepositoryState => ({
  ...tree,
  expanded: Object.fromEntries(paths.map((path) => [path, true as const])),
});

beforeEach(() => {
  resetRepositoryProjectionCache();
});

describe('projectRows', () => {
  it('shows only the root when nothing is expanded', () => {
    const rows = projectRows(tree);

    expect(rows.map((row) => row.path)).toEqual(['src', 'package.json']);
  });

  it('preserves the order the scanner produced', () => {
    // Directories before files comes from the file service; the projection must not
    // re-sort, or the two would disagree.
    expect(projectRows(tree).map((row) => row.name)).toEqual(['src', 'package.json']);
  });

  it('inlines the children of an expanded directory', () => {
    const rows = projectRows(expandedWith('src'));

    expect(rows.map((row) => row.path)).toEqual(['src', 'src/app', 'src/index.ts', 'package.json']);
  });

  it('nests recursively and records depth', () => {
    const rows = projectRows(expandedWith('src', 'src/app'));

    expect(rows.map((row) => `${row.depth}:${row.path}`)).toEqual([
      '0:src',
      '1:src/app',
      '2:src/app/store.ts',
      '1:src/index.ts',
      '0:package.json',
    ]);
  });

  it('costs nothing for a collapsed subtree, however large', () => {
    // This is what makes lazy loading worth having: the projection walks what is
    // visible, not what exists.
    const rows = projectRows(expandedWith('src'));

    expect(rows.some((row) => row.path === 'src/app/store.ts')).toBe(false);
  });

  it('reports an expanded directory whose children have not arrived', () => {
    const loading: RepositoryState = {
      ...tree,
      directories: { ...tree.directories, src: { status: 'loading' } },
      expanded: { src: true },
    };

    const rows = projectRows(loading);

    // The row is present with a loading marker, so the UI shows a spinner rather
    // than an empty folder.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ path: 'src', expanded: true, childrenStatus: 'loading' });
  });

  it('reports a directory that could not be read', () => {
    const failed: RepositoryState = {
      ...tree,
      directories: {
        ...tree.directories,
        src: { status: 'failed', error: { code: 'permission-denied', message: 'nope' } },
      },
      expanded: { src: true },
    };

    expect(projectRows(failed)[0]?.childrenStatus).toBe('failed');
  });

  it('marks git-only nodes as virtual, so a deleted file stays reviewable', () => {
    const withDeleted: RepositoryState = {
      ...tree,
      directories: {
        '': {
          status: 'loaded',
          children: [{ ...node('gone.ts'), virtual: true }],
        },
      },
    };

    expect(projectRows(withDeleted)[0]?.virtual).toBe(true);
  });

  it('returns nothing while the root is still loading', () => {
    expect(projectRows(initialRepositoryState)).toEqual([]);
  });

  it('ignores an expanded flag for a path that no longer exists', () => {
    const stale: RepositoryState = { ...tree, expanded: { 'src/removed': true } };

    expect(projectRows(stale).map((row) => row.path)).toEqual(['src', 'package.json']);
  });
});

describe('memoisation', () => {
  it('returns the identical array when the inputs are unchanged', () => {
    // Performance rule 3. Identity matters, not equality: a new array would make
    // every consumer re-render on unrelated state changes.
    const first = selectRepositoryRows(tree);
    const second = selectRepositoryRows(tree);

    expect(second).toBe(first);
  });

  it('recomputes when the expansion changes', () => {
    const collapsed = selectRepositoryRows(tree);
    const expanded = selectRepositoryRows(expandedWith('src'));

    expect(expanded).not.toBe(collapsed);
    expect(expanded).toHaveLength(4);
  });

  it('recomputes when a directory is loaded', () => {
    const before = selectRepositoryRows(tree);
    const after = selectRepositoryRows({
      ...tree,
      directories: { ...tree.directories, '': { status: 'loaded', children: [node('only.ts')] } },
    });

    expect(after).not.toBe(before);
  });

  it('does not recompute when an unrelated field changes', () => {
    const before = selectRepositoryRows(tree);
    const after = selectRepositoryRows({ ...tree, selectedPath: 'package.json' });

    // Selecting a row must not rebuild the tree.
    expect(after).toBe(before);
  });
});

describe('parentOf', () => {
  it.each([
    ['src/app/store.ts', 'src/app'],
    ['src/index.ts', 'src'],
    ['package.json', ''],
    ['', ''],
  ])('maps %o to %o', (path, expected) => {
    expect(parentOf(path)).toBe(expected);
  });
});

describe('ancestorsOf', () => {
  it('lists every directory that must be open to reveal a path', () => {
    expect(ancestorsOf('src/app/store.ts')).toEqual(['', 'src', 'src/app']);
  });

  it('returns just the root for a top-level entry', () => {
    expect(ancestorsOf('package.json')).toEqual(['']);
  });

  it('returns just the root for the root', () => {
    expect(ancestorsOf('')).toEqual(['']);
  });
});

describe('pathStillExists', () => {
  it('is true for a path present in its loaded parent', () => {
    expect(pathStillExists(tree, 'src/index.ts')).toBe(true);
  });

  it('is false for a path absent from its loaded parent', () => {
    expect(pathStillExists(tree, 'src/deleted.ts')).toBe(false);
  });

  it('is true when the parent has not been loaded', () => {
    // Unknown is not the same as gone: a selection deep in a collapsed subtree must
    // not be discarded just because we have not read that folder yet.
    expect(pathStillExists(tree, 'other/deep/file.ts')).toBe(true);
  });

  it('is true when the parent failed to load', () => {
    const failed: RepositoryState = {
      ...tree,
      directories: {
        ...tree.directories,
        src: { status: 'failed', error: { code: 'permission-denied', message: 'nope' } },
      },
    };

    expect(pathStillExists(failed, 'src/index.ts')).toBe(true);
  });
});
