import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { isWithin, normalizeRoot, resolveInside, toPosix, workspaceName } from './paths';

/**
 * These tests are written against `path`'s behaviour on whichever platform they
 * run on, because that is what production does. The win32-only and posix-only
 * blocks are skipped elsewhere rather than faked — a green suite on Windows must
 * not imply the POSIX behaviour was checked.
 */
const onWin32 = process.platform === 'win32';
const describeWin32 = onWin32 ? describe : describe.skip;
const describePosix = onWin32 ? describe.skip : describe;

const root = onWin32 ? 'C:\\work\\repo' : '/work/repo';

describe('isWithin', () => {
  it('accepts the root itself', () => {
    expect(isWithin(root, root)).toBe(true);
  });

  it('accepts a descendant', () => {
    expect(isWithin(root, path.join(root, 'src', 'index.ts'))).toBe(true);
  });

  it('rejects the parent', () => {
    expect(isWithin(root, path.dirname(root))).toBe(false);
  });

  it('rejects a sibling whose name merely starts with the root', () => {
    // The classic prefix-comparison bug: `C:\work\repo` does not contain
    // `C:\work\repository`, even though one string starts with the other.
    expect(isWithin(root, `${root}sitory`)).toBe(false);
    expect(isWithin(root, `${root}-backup`)).toBe(false);
  });

  it('rejects a traversal that climbs out', () => {
    expect(isWithin(root, path.join(root, '..', '..', 'etc'))).toBe(false);
  });

  it('accepts a traversal that comes back inside', () => {
    expect(isWithin(root, path.join(root, 'src', '..', 'lib'))).toBe(true);
  });

  it('ignores a trailing separator on the root', () => {
    expect(isWithin(`${root}${path.sep}`, path.join(root, 'a'))).toBe(true);
  });
});

describeWin32('isWithin on Windows', () => {
  it('compares case-insensitively, matching the filesystem', () => {
    expect(isWithin('C:\\Work\\Repo', 'C:\\work\\repo\\src')).toBe(true);
  });

  it('rejects a path on another drive', () => {
    expect(isWithin('C:\\work\\repo', 'D:\\work\\repo\\src')).toBe(false);
  });

  it('treats forward slashes as separators', () => {
    expect(isWithin('C:\\work\\repo', 'C:/work/repo/src')).toBe(true);
  });
});

describePosix('isWithin on POSIX', () => {
  it('compares case-sensitively', () => {
    expect(isWithin('/work/repo', '/Work/Repo/src')).toBe(false);
  });
});

describe('normalizeRoot', () => {
  it('strips a trailing separator', () => {
    expect(normalizeRoot(`${root}${path.sep}`)).toBe(root);
  });

  it('keeps the separator on a filesystem root, which needs it to stay absolute', () => {
    const filesystemRoot = onWin32 ? 'C:\\' : '/';
    expect(normalizeRoot(filesystemRoot)).toBe(filesystemRoot);
  });

  it('collapses redundant segments', () => {
    expect(normalizeRoot(path.join(root, 'src', '..'))).toBe(root);
  });

  it('is idempotent', () => {
    expect(normalizeRoot(normalizeRoot(root))).toBe(normalizeRoot(root));
  });
});

describe('workspaceName', () => {
  it('uses the last segment', () => {
    expect(workspaceName(root)).toBe('repo');
  });

  it('falls back to the volume when there are no segments', () => {
    const filesystemRoot = onWin32 ? 'C:\\' : '/';
    expect(workspaceName(filesystemRoot)).not.toBe('');
  });
});

describe('resolveInside', () => {
  it('resolves an ordinary relative path', () => {
    const result = resolveInside(root, 'src/app/store.ts');
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('unreachable');
    }
    expect(result.value).toBe(path.join(root, 'src', 'app', 'store.ts'));
  });

  it.each(['', '.'])('maps %o to the root', (input) => {
    const result = resolveInside(root, input);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('unreachable');
    }
    expect(result.value).toBe(root);
  });

  it('rejects a NUL byte before it can reach a syscall', () => {
    const result = resolveInside(root, 'src/\0/etc');
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.error.code).toBe('invalid-request');
  });

  it.each(['../outside', '../../etc/passwd', 'src/../../outside', 'a/b/../../../outside'])(
    'rejects the traversal %o',
    (input) => {
      const result = resolveInside(root, input);
      expect(result.ok).toBe(false);
      if (result.ok) {
        throw new Error('unreachable');
      }
      expect(result.error.code).toBe('path-outside-workspace');
    },
  );

  it.each([
    // Absolute in POSIX syntax.
    '/etc/passwd',
    // Absolute in Windows syntax — rejected on POSIX too, where it would
    // otherwise be read as a relative filename containing a colon.
    'C:/Windows/System32',
    'C:\\Windows\\System32',
    // UNC.
    '//server/share',
    '\\\\server\\share',
  ])('rejects the absolute path %o', (input) => {
    const result = resolveInside(root, input);
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.error.code).toBe('path-outside-workspace');
  });

  it('allows a traversal that stays inside', () => {
    const result = resolveInside(root, 'src/../lib/index.ts');
    expect(result.ok).toBe(true);
  });
});

describe('toPosix', () => {
  it('produces forward slashes regardless of platform', () => {
    expect(toPosix(path.join('src', 'app', 'store.ts'))).toBe('src/app/store.ts');
  });
});
