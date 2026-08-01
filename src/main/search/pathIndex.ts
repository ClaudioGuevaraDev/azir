import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { isIgnoredPath } from '@shared/constants/ignore';

/**
 * Walks a workspace once and returns every file path in it.
 *
 * This exists because of one sentence in docs/architecture.md: "Path search operates on an
 * in-memory path index and should respond on every keystroke without IPC." An index is the only
 * way to honour that — asking main per keystroke is IPC per keystroke, and asking the repository
 * tree is not an option because the tree is lazy and only knows about directories the user has
 * expanded.
 *
 * Three properties matter more than speed:
 *
 *  - **It yields.** A workspace can hold hundreds of thousands of entries, and main is the
 *    process PTY bytes flow through. Invariant 8 — "PTY traffic never waits behind git, search or
 *    filesystem scans" — is not something a single uninterrupted walk can honour, so the loop
 *    hands the event loop back at a fixed interval.
 *  - **It is bounded.** A very large or accidentally-rooted-at-C:\ workspace produces a truncated
 *    index rather than an unbounded array, and says so.
 *  - **It shares the ignore list.** The same `isIgnoredPath` the scanner and the watcher use, so
 *    search cannot offer a file the tree refuses to show or the watcher refuses to follow.
 */

export interface PathIndex {
  /** Workspace-relative POSIX paths of files. Directories are not searchable targets. */
  readonly paths: readonly string[];
  /** True when the limit was reached and the walk stopped early. */
  readonly truncated: boolean;
}

export interface BuildPathIndexOptions {
  /** Hard cap on entries. Reached, the walk stops and reports `truncated`. */
  readonly limit?: number;
  /** Entries visited between yields to the event loop. */
  readonly yieldEvery?: number;
  /** Injected in tests, and the seam that keeps this module free of a real filesystem. */
  readonly readDirectory?: (absolute: string) => Promise<readonly DirectoryChild[]>;
  /** Polled between directories; returning false abandons the walk. */
  readonly shouldContinue?: () => boolean;
  readonly yieldToEventLoop?: () => Promise<void>;
}

export interface DirectoryChild {
  readonly name: string;
  readonly isDirectory: boolean;
}

const DEFAULT_LIMIT = 200_000;
const DEFAULT_YIELD_EVERY = 2_000;

const defaultReadDirectory = async (absolute: string): Promise<readonly DirectoryChild[]> => {
  const entries = await readdir(absolute, { withFileTypes: true });
  return entries.map((entry) => ({ name: entry.name, isDirectory: entry.isDirectory() }));
};

const defaultYield = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export const buildPathIndex = async (
  root: string,
  options: BuildPathIndexOptions = {},
): Promise<PathIndex> => {
  const limit = options.limit ?? DEFAULT_LIMIT;
  const yieldEvery = options.yieldEvery ?? DEFAULT_YIELD_EVERY;
  const readDirectory = options.readDirectory ?? defaultReadDirectory;
  const shouldContinue = options.shouldContinue ?? (() => true);
  const yieldToEventLoop = options.yieldToEventLoop ?? defaultYield;

  const paths: string[] = [];
  let truncated = false;
  let sinceYield = 0;

  /*
   * Breadth-first with an explicit queue rather than recursion. A deeply nested workspace — or a
   * symlink loop that slipped past the watcher's `followSymlinks: false` — would blow the stack,
   * and a stack overflow in main takes the whole application with it.
   */
  const queue: string[] = [''];

  while (queue.length > 0) {
    const relative = queue.shift() as string;

    if (!shouldContinue()) {
      return { paths, truncated: true };
    }

    let children: readonly DirectoryChild[];
    try {
      children = await readDirectory(relative === '' ? root : path.join(root, relative));
    } catch {
      // A directory that cannot be read is skipped, not fatal. Permission errors and
      // directories deleted mid-walk are both ordinary in a workspace an agent is writing to.
      continue;
    }

    for (const child of children) {
      const childPath = relative === '' ? child.name : `${relative}/${child.name}`;
      if (isIgnoredPath(childPath)) {
        continue;
      }

      if (child.isDirectory) {
        queue.push(childPath);
        continue;
      }

      if (paths.length >= limit) {
        truncated = true;
        return { paths, truncated };
      }
      paths.push(childPath);
    }

    sinceYield += children.length;
    if (sinceYield >= yieldEvery) {
      sinceYield = 0;
      await yieldToEventLoop();
    }
  }

  return { paths, truncated };
};
