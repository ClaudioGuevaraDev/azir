import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { isIgnoredPath } from '@shared/constants/ignore';
import type { DirectoryEntry } from '@shared/ipc/contracts';
import { describeError, err, ok, type Result } from '@shared/ipc/result';

/**
 * Filesystem reads for the repository panel.
 *
 * Three things it must get right, all called out in docs/architecture.md:
 *
 *  - **Deterministic ordering.** The tree is rebuilt on every refresh, and rows that
 *    reshuffle between refreshes are unusable — the row under the cursor moves as
 *    you reach for it. `readdir` order is filesystem-dependent, so sorting here is
 *    not cosmetic.
 *  - **An unreadable directory is a state, not a crash.** A permission-denied folder
 *    inside the workspace renders as a failed row while everything around it keeps
 *    working (invariant 13).
 *  - **One syscall per directory, not per entry.** `readdir` with file types already
 *    reports the kind, so nothing here stats individual files. A `node_modules`-sized
 *    directory would otherwise cost thousands of syscalls to draw a list of names.
 *    Symlinks are the one exception: their kind genuinely depends on their target.
 */

export interface FileService {
  /**
   * Lists one directory. `absolutePath` has already been resolved and sandboxed by
   * the session registry; `relativePosix` is passed through so entries can carry
   * their own stable identity.
   */
  listDirectory(absolutePath: string, relativePosix: string): Promise<Result<DirectoryEntry[]>>;
}

export interface RawEntry {
  readonly name: string;
  readonly isDirectory: boolean;
  /** True for symlinks, whose target has to be resolved before the kind is known. */
  readonly isSymbolicLink: boolean;
}

export interface FileServiceOptions {
  /** Injected so tests need no real directories. */
  readonly readDirectory?: (absolutePath: string) => Promise<RawEntry[]>;
  readonly isDirectoryTarget?: (absolutePath: string) => Promise<boolean>;
}

const defaultReadDirectory = async (absolutePath: string): Promise<RawEntry[]> => {
  const dirents = await readdir(absolutePath, { withFileTypes: true });
  return dirents.map((dirent) => ({
    name: dirent.name,
    isDirectory: dirent.isDirectory(),
    isSymbolicLink: dirent.isSymbolicLink(),
  }));
};

const defaultIsDirectoryTarget = async (absolutePath: string): Promise<boolean> => {
  const stats = await stat(absolutePath);
  return stats.isDirectory();
};

/**
 * Directories first, then files; within each group, case-insensitive by name with a
 * case-sensitive tiebreak.
 *
 * `Intl.Collator` is deliberately not used: its ordering depends on the machine's
 * locale, so two developers would see different trees and a sort assertion would
 * pass on one and fail on the other.
 */
const compareEntries = (a: DirectoryEntry, b: DirectoryEntry): number => {
  if (a.kind !== b.kind) {
    return a.kind === 'directory' ? -1 : 1;
  }
  const lowerA = a.name.toLowerCase();
  const lowerB = b.name.toLowerCase();
  if (lowerA !== lowerB) {
    return lowerA < lowerB ? -1 : 1;
  }
  // `README` and `readme` differ only in case; without this their relative order
  // would come from readdir and vary between machines.
  if (a.name === b.name) {
    return 0;
  }
  return a.name < b.name ? -1 : 1;
};

const joinRelative = (parent: string, name: string): string =>
  parent === '' ? name : `${parent}/${name}`;

const classify = (error: unknown): ReturnType<typeof err> => {
  const code = (error as { code?: string }).code;
  const detail = describeError(error);

  if (code === 'ENOENT') {
    return err('not-found', 'That folder no longer exists.', detail);
  }
  if (code === 'EACCES' || code === 'EPERM') {
    return err('permission-denied', 'That folder could not be read.', detail);
  }
  if (code === 'ENOTDIR') {
    return err('not-a-file', 'That path is not a folder.', detail);
  }
  return err('internal', 'That folder could not be read.', detail);
};

export const createFileService = (options: FileServiceOptions = {}): FileService => {
  const readDirectory = options.readDirectory ?? defaultReadDirectory;
  const isDirectoryTarget = options.isDirectoryTarget ?? defaultIsDirectoryTarget;

  return {
    async listDirectory(absolutePath, relativePosix) {
      let raw: RawEntry[];
      try {
        raw = await readDirectory(absolutePath);
      } catch (error) {
        return classify(error);
      }

      const entries: DirectoryEntry[] = [];

      for (const entry of raw) {
        const entryPath = joinRelative(relativePosix, entry.name);

        // Filtered here rather than in the UI, so the scanner and the watcher agree
        // about what exists.
        if (isIgnoredPath(entryPath)) {
          continue;
        }

        let kind: DirectoryEntry['kind'] = entry.isDirectory ? 'directory' : 'file';
        if (entry.isSymbolicLink) {
          try {
            kind = (await isDirectoryTarget(path.join(absolutePath, entry.name)))
              ? 'directory'
              : 'file';
          } catch {
            // A broken symlink is listable but not walkable, so it shows as a file
            // rather than as an expandable directory that can never open.
            kind = 'file';
          }
        }

        entries.push({ path: entryPath, name: entry.name, kind });
      }

      entries.sort(compareEntries);
      return ok(entries);
    },
  };
};
