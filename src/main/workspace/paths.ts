import path from 'node:path';
import { err, ok, type Result } from '@shared/ipc/result';

/**
 * Path handling for the workspace sandbox.
 *
 * docs/architecture.md, Security: "normalize and validate workspace paths" and
 * "ensure file operations stay inside the active workspace". This module is the
 * single implementation of that check — no other file in src/main should be
 * joining a renderer-supplied string onto a root.
 *
 * The subtleties this has to survive:
 *
 *   - `C:\a` must not be treated as containing `C:\ab`, even though one string
 *     is a prefix of the other. Prefix comparison is the classic wrong answer.
 *   - Windows path comparison is case-insensitive; POSIX comparison is not.
 *     `path.relative` already handles that difference on win32.
 *   - `..` segments, absolute paths in either syntax, and NUL bytes all have to
 *     be refused before they reach the filesystem.
 */

/** Normalise a root for storage: absolute, no trailing separator, resolved. */
export const normalizeRoot = (root: string): string => {
  const resolved = path.resolve(root);
  if (resolved.length <= 1) {
    return resolved;
  }
  // `path.resolve` already strips trailing separators except on a bare root like
  // `C:\` or `/`, which must keep it to stay absolute.
  const isFilesystemRoot = resolved === path.parse(resolved).root;
  return isFilesystemRoot ? resolved : resolved.replace(/[\\/]+$/, '');
};

/**
 * A displayable name for a root. Falls back to the volume when the path has no
 * segments, so `C:\` shows as `C:` rather than as an empty string.
 */
export const workspaceName = (root: string): string => {
  const base = path.basename(root);
  if (base !== '') {
    return base;
  }
  const { root: volume } = path.parse(root);
  return volume.replace(/[\\/]+$/, '') || volume;
};

/**
 * True when `candidate` is `root` itself or lies beneath it.
 *
 * Implemented with `path.relative` rather than string prefixing: a relative path
 * that neither starts with `..` nor is absolute is, by definition, a descendant.
 */
export const isWithin = (root: string, candidate: string): boolean => {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  if (relative === '') {
    return true;
  }
  if (relative === '..' || relative.startsWith(`..${path.sep}`)) {
    return false;
  }
  // On win32, `path.relative` between different drives returns an absolute path.
  return !path.isAbsolute(relative);
};

/** Convert a native path to the POSIX form used on the wire. */
export const toPosix = (nativePath: string): string => nativePath.split(path.sep).join('/');

/** Convert a POSIX wire path back to the platform's native form. */
export const fromPosix = (posixPath: string): string => posixPath.split('/').join(path.sep);

/**
 * Resolve a workspace-relative POSIX path against a trusted root, refusing
 * anything that escapes.
 *
 * `relativePosix` comes from the renderer and is therefore untrusted; `root`
 * comes from the session registry and is therefore trusted.
 */
export const resolveInside = (root: string, relativePosix: string): Result<string> => {
  if (relativePosix.includes('\0')) {
    return err('invalid-request', 'Path contains a NUL byte.');
  }

  if (relativePosix === '' || relativePosix === '.') {
    return ok(normalizeRoot(root));
  }

  // Checked in both syntaxes: on POSIX, `C:\Windows` is a valid *relative* name,
  // and on win32, `/etc/passwd` is absolute. Neither should be accepted as a
  // workspace-relative path on either platform.
  if (path.posix.isAbsolute(relativePosix) || path.win32.isAbsolute(relativePosix)) {
    return err('path-outside-workspace', 'Path must be relative to the workspace root.');
  }

  const normalizedRoot = normalizeRoot(root);
  const candidate = path.resolve(normalizedRoot, fromPosix(relativePosix));

  if (!isWithin(normalizedRoot, candidate)) {
    return err('path-outside-workspace', 'Path resolves outside the workspace.');
  }

  return ok(candidate);
};
