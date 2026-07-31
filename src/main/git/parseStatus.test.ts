import { describe, expect, it } from 'vitest';
import { parseStatus } from './parseStatus';

/**
 * Fixtures are written as the byte sequences git actually emits: records terminated
 * by NUL, and — for renames — an extra NUL *inside* the record. Building them from
 * arrays and joining with `\0` keeps that visible rather than hidden in a string
 * literal.
 */
const records = (...items: string[]): string => `${items.join('\0')}\0`;

const HEADERS = [
  '# branch.oid 1a2b3c4d5e6f',
  '# branch.head main',
  '# branch.upstream origin/main',
  '# branch.ab +2 -1',
];

describe('branch header', () => {
  it('reads the branch, commit, upstream and ahead/behind', () => {
    const { branch } = parseStatus(records(...HEADERS));

    expect(branch).toEqual({
      head: 'main',
      commit: '1a2b3c4d5e6f',
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
      detached: false,
    });
  });

  it('reports a repository with no commits as such rather than as an error', () => {
    const { branch } = parseStatus(records('# branch.oid (initial)', '# branch.head main'));

    // A fresh repository is a perfectly normal thing to supervise; every file in it
    // is simply untracked.
    expect(branch.commit).toBeNull();
    expect(branch.head).toBe('main');
  });

  it('reports a detached HEAD', () => {
    const { branch } = parseStatus(records('# branch.oid abc', '# branch.head (detached)'));

    expect(branch.detached).toBe(true);
    expect(branch.head).toBeNull();
  });

  it('defaults ahead/behind to zero when there is no upstream', () => {
    const { branch } = parseStatus(records('# branch.oid abc', '# branch.head main'));

    expect(branch).toMatchObject({ upstream: null, ahead: 0, behind: 0 });
  });

  it('handles a branch name containing a slash', () => {
    const { branch } = parseStatus(records('# branch.head feature/nested/name'));

    expect(branch.head).toBe('feature/nested/name');
  });
});

describe('ordinary changes', () => {
  it('separates the index side from the working-tree side', () => {
    // `MM` is the case a single collapsed status cannot express: staged edits plus
    // further unstaged edits on the same file.
    const { files } = parseStatus(records('1 MM N... 100644 100644 100644 aaa bbb src/index.ts'));

    expect(files[0]).toEqual({
      path: 'src/index.ts',
      staged: 'modified',
      unstaged: 'modified',
      conflicted: false,
    });
  });

  it.each([
    ['1 M. N... 100644 100644 100644 aaa bbb a.ts', 'modified', null],
    ['1 .M N... 100644 100644 100644 aaa bbb a.ts', null, 'modified'],
    ['1 A. N... 000000 100644 100644 aaa bbb a.ts', 'added', null],
    ['1 D. N... 100644 000000 000000 aaa bbb a.ts', 'deleted', null],
    ['1 .D N... 100644 100644 000000 aaa bbb a.ts', null, 'deleted'],
    ['1 T. N... 100644 120000 120000 aaa bbb a.ts', 'type-changed', null],
  ])('maps %o correctly', (record, staged, unstaged) => {
    const { files } = parseStatus(records(record));

    expect(files[0]).toMatchObject({ staged, unstaged });
  });

  it('keeps a path containing spaces intact', () => {
    // The path is the last field, so the field split has to be bounded rather than a
    // plain split on space.
    const { files } = parseStatus(
      records('1 .M N... 100644 100644 100644 aaa bbb docs/my great file.md'),
    );

    expect(files[0]?.path).toBe('docs/my great file.md');
  });

  it('keeps a non-ASCII path intact', () => {
    const { files } = parseStatus(
      records('1 .M N... 100644 100644 100644 aaa bbb src/año/configuración.ts'),
    );

    expect(files[0]?.path).toBe('src/año/configuración.ts');
  });
});

describe('renames', () => {
  it('reads both paths, including the NUL inside the record', () => {
    // The bug this module exists to prevent: splitting the whole output on NUL treats
    // the original path as the next record.
    const { files } = parseStatus(
      records('2 R. N... 100644 100644 100644 aaa bbb R100 new/name.ts\0old/name.ts'),
    );

    expect(files).toHaveLength(1);
    expect(files[0]).toEqual({
      path: 'new/name.ts',
      staged: 'renamed',
      unstaged: null,
      originalPath: 'old/name.ts',
      conflicted: false,
    });
  });

  it('does not swallow the record that follows a rename', () => {
    const { files } = parseStatus(
      records(
        '2 R. N... 100644 100644 100644 aaa bbb R100 new/name.ts\0old/name.ts',
        '1 .M N... 100644 100644 100644 aaa bbb src/after.ts',
      ),
    );

    // Two files, not one: mis-handling the embedded NUL loses the second.
    expect(files.map((file) => file.path)).toEqual(['new/name.ts', 'src/after.ts']);
  });

  it('handles two renames in a row', () => {
    const { files } = parseStatus(
      records(
        '2 R. N... 100644 100644 100644 aaa bbb R100 a2.ts\0a1.ts',
        '2 R. N... 100644 100644 100644 ccc ddd R090 b2.ts\0b1.ts',
      ),
    );

    expect(files.map((file) => `${file.originalPath}→${file.path}`)).toEqual([
      'a1.ts→a2.ts',
      'b1.ts→b2.ts',
    ]);
  });

  it('handles a rename whose paths contain spaces', () => {
    const { files } = parseStatus(
      records('2 R. N... 100644 100644 100644 aaa bbb R100 new name.ts\0old name.ts'),
    );

    expect(files[0]).toMatchObject({ path: 'new name.ts', originalPath: 'old name.ts' });
  });

  it('reads a copy the same way', () => {
    const { files } = parseStatus(
      records('2 C. N... 100644 100644 100644 aaa bbb C100 copy.ts\0source.ts'),
    );

    expect(files[0]).toMatchObject({ staged: 'copied', originalPath: 'source.ts' });
  });
});

describe('untracked and ignored', () => {
  it('marks an untracked file as unstaged', () => {
    const { files } = parseStatus(records('? src/brand-new.ts'));

    expect(files[0]).toEqual({
      path: 'src/brand-new.ts',
      staged: null,
      unstaged: 'untracked',
      conflicted: false,
    });
  });

  it('keeps an untracked path with spaces intact', () => {
    const { files } = parseStatus(records('? my new file.txt'));

    expect(files[0]?.path).toBe('my new file.txt');
  });

  it('marks an ignored file', () => {
    const { files } = parseStatus(records('! build/output.js'));

    expect(files[0]?.unstaged).toBe('ignored');
  });
});

describe('conflicts', () => {
  it('flags an unmerged path distinctly from a modification', () => {
    // A conflict needs a decision, not review, so it must not be presented as an
    // ordinary edit.
    const { files } = parseStatus(
      records('u UU N... 100644 100644 100644 100644 aaa bbb ccc src/conflicted.ts'),
    );

    expect(files[0]).toEqual({
      path: 'src/conflicted.ts',
      staged: null,
      unstaged: null,
      conflicted: true,
    });
  });
});

describe('robustness', () => {
  it('returns an empty result for a clean repository', () => {
    const { files, branch } = parseStatus(records(...HEADERS));

    expect(files).toEqual([]);
    expect(branch.head).toBe('main');
  });

  it('handles completely empty output', () => {
    const { files, branch } = parseStatus('');

    expect(files).toEqual([]);
    expect(branch.head).toBeNull();
  });

  it('skips an unrecognised record rather than throwing', () => {
    // A future git adding a record type must not blank the whole panel.
    const { files } = parseStatus(
      records('x something new', '1 .M N... 100644 100644 100644 aaa bbb known.ts'),
    );

    expect(files.map((file) => file.path)).toEqual(['known.ts']);
  });

  it('sorts by path, so the changes view is stable between refreshes', () => {
    // git emits in index order; relying on that would make the list reorder whenever
    // the index did.
    const { files } = parseStatus(
      records('? zebra.ts', '1 .M N... 100644 100644 100644 aaa bbb alpha.ts', '? middle.ts'),
    );

    expect(files.map((file) => file.path)).toEqual(['alpha.ts', 'middle.ts', 'zebra.ts']);
  });

  it('parses a realistic mixed status', () => {
    const { branch, files } = parseStatus(
      records(
        ...HEADERS,
        '1 .M N... 100644 100644 100644 aaa bbb src/renderer/App.tsx',
        '1 A. N... 000000 100644 100644 000 ccc src/main/git/gitService.ts',
        '2 R. N... 100644 100644 100644 ddd eee R100 docs/architecture.md\0ARCHITECTURE.md',
        '1 .D N... 100644 100644 000000 fff ggg src/legacy.ts',
        'u UU N... 100644 100644 100644 100644 h i j package-lock.json',
        '? src/main/watcher/watcherService.ts',
      ),
    );

    expect(branch.head).toBe('main');
    expect(files).toHaveLength(6);
    expect(files.filter((file) => file.conflicted)).toHaveLength(1);
    expect(files.find((file) => file.path === 'docs/architecture.md')?.originalPath).toBe(
      'ARCHITECTURE.md',
    );
  });
});
