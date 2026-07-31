import { describe, expect, it } from 'vitest';
import {
  GIT_DIR_TRIGGERS,
  IGNORED_DIRECTORY_NAMES,
  isGitStateChange,
  isIgnoredPath,
} from './ignore';

/**
 * This list is shared by the scanner and the watcher precisely so they cannot
 * disagree. These tests pin the shape of that agreement.
 */

describe('isIgnoredPath', () => {
  it('does not ignore the workspace root', () => {
    expect(isIgnoredPath('')).toBe(false);
  });

  it.each(['node_modules', '.git', 'dist', 'coverage'])('ignores %s at the top level', (name) => {
    expect(isIgnoredPath(name)).toBe(true);
  });

  it.each([
    'node_modules/react/index.js',
    '.git/objects/ab/cdef',
    'packages/app/node_modules/left-pad/index.js',
    'apps/web/dist/main.js',
  ])('ignores %s at any depth', (path) => {
    expect(isIgnoredPath(path)).toBe(true);
  });

  it.each([
    'src/index.ts',
    'docs/architecture.md',
    'package.json',
    '.gitignore',
    '.github/workflows/ci.yml',
  ])('does not ignore %s', (path) => {
    expect(isIgnoredPath(path)).toBe(false);
  });

  it('matches whole segments only, so a lookalike name is kept', () => {
    // `distribution` is not `dist`, and `.gitignore` is not `.git`. Substring
    // matching here would silently hide real source directories.
    expect(isIgnoredPath('distribution/index.ts')).toBe(false);
    expect(isIgnoredPath('src/buildings/index.ts')).toBe(false);
    expect(isIgnoredPath('.gitignore')).toBe(false);
    expect(isIgnoredPath('outer/index.ts')).toBe(false);
  });
});

describe('isGitStateChange', () => {
  it.each(['.git/HEAD', '.git/index', '.git/MERGE_HEAD', '.git/packed-refs'])(
    'triggers a refresh for %s',
    (path) => {
      expect(isGitStateChange(path)).toBe(true);
    },
  );

  it('triggers for anything under refs', () => {
    expect(isGitStateChange('.git/refs/heads/main')).toBe(true);
  });

  it('ignores the object database, which churns without telling us anything', () => {
    // A single commit writes many objects. Watching them would produce thousands of
    // events per commit while HEAD and index already say everything the tree needs.
    expect(isGitStateChange('.git/objects/ab/cdef0123')).toBe(false);
    expect(isGitStateChange('.git/logs/HEAD')).toBe(false);
  });

  it('does not match a path that merely starts with a trigger name', () => {
    expect(isGitStateChange('.git/HEADER')).toBe(false);
    expect(isGitStateChange('.git/indexes/x')).toBe(false);
  });

  it('keeps the trigger list narrow on purpose', () => {
    expect(GIT_DIR_TRIGGERS).toHaveLength(5);
  });
});

describe('the two lists together', () => {
  it('hides .git from the tree while still watching inside it', () => {
    // Both halves have to hold at once: `.git` is plumbing the user should not
    // browse, but a commit made in the integrated terminal must still refresh the
    // status. Getting one without the other is the bug this pairing prevents.
    expect(IGNORED_DIRECTORY_NAMES.has('.git')).toBe(true);
    expect(isIgnoredPath('.git/HEAD')).toBe(true);
    expect(isGitStateChange('.git/HEAD')).toBe(true);
  });
});
