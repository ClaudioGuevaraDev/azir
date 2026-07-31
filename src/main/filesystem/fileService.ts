import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { isIgnoredPath } from '@shared/constants/ignore';
import type { DirectoryEntry, Eol, ReadFileResponse } from '@shared/ipc/contracts';
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
  /** Reads one file as text, refusing anything the viewer cannot usefully show. */
  readFile(absolutePath: string, relativePosix: string): Promise<Result<ReadFileResponse>>;
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
  readonly readFileBytes?: (absolutePath: string) => Promise<Buffer>;
  readonly statPath?: (absolutePath: string) => Promise<{ size: number; isFile: boolean }>;
  /** Files above this many bytes are refused rather than loaded. */
  readonly maxFileBytes?: number;
}

/**
 * 2 MB.
 *
 * The spec requires large files to be rejected or to need explicit confirmation. The
 * limit is about the renderer, not the disk: a text file this size is already tens of
 * thousands of lines, and the cost that hurts is the decoded string plus a line array
 * plus React's view of it. A minified bundle or a checked-in dataset is the realistic
 * case, and neither is something a person reviews line by line.
 */
const DEFAULT_MAX_FILE_BYTES = 2 * 1024 * 1024;

/**
 * How much of a file to inspect when deciding whether it is binary.
 *
 * Matches git's own heuristic: a NUL byte near the start means "not text". Reading only
 * the head would need a file handle and a partial read; since the whole file is already
 * bounded by the size guard, scanning a prefix of the buffer is simpler and equivalent.
 */
const BINARY_SNIFF_BYTES = 8000;

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

const BOM = '﻿';

/** LF, CRLF, or a file that contains both. */
const detectEol = (text: string): Eol => {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  if (crlf === 0) {
    return 'lf';
  }
  // Counting bare LFs means counting the ones not preceded by CR.
  const lf = (text.match(/(?<!\r)\n/g) ?? []).length;
  return lf === 0 ? 'crlf' : 'mixed';
};

const looksBinary = (bytes: Buffer): boolean => {
  const limit = Math.min(bytes.length, BINARY_SNIFF_BYTES);
  for (let index = 0; index < limit; index += 1) {
    if (bytes[index] === 0) {
      return true;
    }
  }
  return false;
};

export const createFileService = (options: FileServiceOptions = {}): FileService => {
  const readDirectory = options.readDirectory ?? defaultReadDirectory;
  const isDirectoryTarget = options.isDirectoryTarget ?? defaultIsDirectoryTarget;
  const readFileBytes = options.readFileBytes ?? ((target) => readFile(target));
  const statPath =
    options.statPath ??
    (async (target) => {
      const stats = await stat(target);
      return { size: stats.size, isFile: stats.isFile() };
    });
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;

  return {
    async readFile(absolutePath, relativePosix) {
      // Statted first so an oversized file is refused without ever being read into
      // memory — reading it and then rejecting would defeat the point of the guard.
      let info: { size: number; isFile: boolean };
      try {
        info = await statPath(absolutePath);
      } catch (error) {
        return classify(error);
      }

      if (!info.isFile) {
        return err('not-a-file', 'That path is not a file.');
      }

      if (info.size > maxFileBytes) {
        return err(
          'too-large',
          `That file is ${Math.round(info.size / 1024)} KB, above the ${Math.round(
            maxFileBytes / 1024,
          )} KB the viewer will load.`,
        );
      }

      let bytes: Buffer;
      try {
        bytes = await readFileBytes(absolutePath);
      } catch (error) {
        return classify(error);
      }

      if (looksBinary(bytes)) {
        // Reported as a state rather than rendered as mojibake: the spec lists binary
        // content among the expected failures, and a viewer full of replacement
        // characters is worse than an honest message.
        return err('binary-content', 'That file is binary and cannot be shown as text.');
      }

      const decoded = bytes.toString('utf8');
      const hadBom = decoded.startsWith(BOM);
      const content = hadBom ? decoded.slice(BOM.length) : decoded;

      return ok({
        path: relativePosix,
        content,
        eol: detectEol(content),
        hadBom,
        byteSize: info.size,
      });
    },

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
