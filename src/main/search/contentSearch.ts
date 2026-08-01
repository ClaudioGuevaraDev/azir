import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { ContentMatch } from '@shared/ipc/contracts';

/**
 * Searches the contents of an already-built path index.
 *
 * Reusing the index rather than walking again is not only cheaper: it means path search and
 * content search can never disagree about which files exist, the same reason the scanner and the
 * watcher share an ignore list.
 *
 * **Literal, case-insensitive substring. Not a regular expression.** The query arrives from the
 * renderer, which is untrusted, and a user-supplied pattern like `(a+)+$` is a denial of service
 * against the main process — the one place PTY bytes and every file operation flow through. No
 * amount of validation makes an arbitrary regex safe to run there, so the feature is not offered.
 * A literal search is also what someone reviewing an agent's work actually types.
 */

export interface ContentSearchResult {
  readonly matches: readonly ContentMatch[];
  /** True when a limit stopped the search before it had looked at everything. */
  readonly truncated: boolean;
  readonly filesScanned: number;
}

export interface ContentSearchOptions {
  readonly root: string;
  readonly paths: readonly string[];
  readonly query: string;
  readonly maxMatches?: number;
  readonly maxFiles?: number;
  /** Files larger than this are skipped: they are build artefacts or data, not code to review. */
  readonly maxFileBytes?: number;
  /** Files read between yields to the event loop. */
  readonly yieldEvery?: number;
  readonly readFileText?: (absolute: string) => Promise<string>;
  /** Polled between files; returning false abandons the search. See the note on superseding. */
  readonly shouldContinue?: () => boolean;
  readonly yieldToEventLoop?: () => Promise<void>;
}

const DEFAULT_MAX_MATCHES = 500;
const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_FILE_BYTES = 1024 * 1024;
const DEFAULT_YIELD_EVERY = 24;

/** How much of a line is sent back. Long minified lines would otherwise dominate the payload. */
const PREVIEW_LIMIT = 240;

const defaultYield = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * True when the buffer looks like binary.
 *
 * A NUL byte in the first few kilobytes is the same heuristic `git diff` uses, and the same one
 * the file reader already applies. Without it a search for `e` matches most of a PNG and the
 * results list fills with control characters.
 */
const looksBinary = (text: string): boolean => text.includes('\0');

export const searchContent = async (
  options: ContentSearchOptions,
): Promise<ContentSearchResult> => {
  const maxMatches = options.maxMatches ?? DEFAULT_MAX_MATCHES;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = options.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const yieldEvery = options.yieldEvery ?? DEFAULT_YIELD_EVERY;
  const shouldContinue = options.shouldContinue ?? (() => true);
  const yieldToEventLoop = options.yieldToEventLoop ?? defaultYield;
  const readFileText = options.readFileText ?? ((absolute: string) => readFile(absolute, 'utf8'));

  const needle = options.query.toLowerCase();
  const matches: ContentMatch[] = [];
  let filesScanned = 0;
  let truncated = false;

  if (needle === '') {
    return { matches, truncated: false, filesScanned: 0 };
  }

  for (const relative of options.paths) {
    if (!shouldContinue()) {
      return { matches, truncated: true, filesScanned };
    }
    if (filesScanned >= maxFiles) {
      truncated = true;
      break;
    }

    let text: string;
    try {
      text = await readFileText(path.join(options.root, ...relative.split('/')));
    } catch {
      // Deleted between the index being built and now, or unreadable. Neither is worth
      // reporting: the file simply is not part of the result.
      continue;
    }
    filesScanned += 1;

    if (text.length > maxFileBytes || looksBinary(text)) {
      continue;
    }

    // Cheap reject before splitting into lines, which is the expensive part on a large file.
    const haystack = text.toLowerCase();
    if (!haystack.includes(needle)) {
      if (filesScanned % yieldEvery === 0) {
        await yieldToEventLoop();
      }
      continue;
    }

    const lines = text.split('\n');
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index] ?? '';
      const column = line.toLowerCase().indexOf(needle);
      if (column === -1) {
        continue;
      }
      if (matches.length >= maxMatches) {
        // Stopped, and said so. A silent cap reads as "that is all there is", which is the one
        // thing a search result must never lie about.
        return { matches, truncated: true, filesScanned };
      }
      matches.push({
        path: relative,
        line: index + 1,
        column: column + 1,
        // Trailing \r kept out of the preview so a CRLF file does not render with a stray glyph.
        preview: line.replace(/\r$/, '').slice(0, PREVIEW_LIMIT),
      });
    }

    if (filesScanned % yieldEvery === 0) {
      await yieldToEventLoop();
    }
  }

  return { matches, truncated, filesScanned };
};
