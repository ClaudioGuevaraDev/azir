import type { GitBranchInfo, GitChangeKind, GitFileStatus } from '@shared/ipc/contracts';

/**
 * Parses `git status --porcelain=v2 --branch -z -uall`.
 *
 * Why v2 and not v1: v1 gives no rename source without extra parsing, no
 * ahead/behind, and collapses submodule state. Why `-z`: v1 and v2 both C-quote
 * paths in their default mode, so a filename containing a quote, a backslash or a
 * newline has to be unescaped — and getting that wrong on a path is how a status
 * parser starts reporting files that do not exist. With `-z` the bytes are raw and
 * records are NUL-terminated.
 *
 * The subtlety that makes this worth its own module: **a rename record contains a
 * NUL of its own.** Type-2 records are
 *
 *     2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>\0
 *
 * so a parser that simply splits the whole output on NUL and treats each piece as a
 * record will read the *original path* as the next record, fail to recognise it, and
 * silently drop it — or worse, mis-attribute the following file's status. This
 * parser consumes tokens with a cursor and pulls the extra token when it sees a
 * type-2 record.
 */

export interface ParsedStatus {
  readonly branch: GitBranchInfo;
  readonly files: readonly GitFileStatus[];
}

export const emptyBranch: GitBranchInfo = {
  head: null,
  commit: null,
  upstream: null,
  ahead: 0,
  behind: 0,
  detached: false,
};

/**
 * The XY status characters. `.` means "no change on this side" — not "unmodified
 * file", which is why it maps to null rather than to a kind.
 */
const KIND_BY_CODE: Readonly<Record<string, GitChangeKind>> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type-changed',
};

const kindOf = (code: string | undefined): GitChangeKind | null => {
  if (code === undefined || code === '.' || code === ' ') {
    return null;
  }
  return KIND_BY_CODE[code] ?? 'modified';
};

const parseBranchHeader = (line: string, branch: GitBranchInfo): GitBranchInfo => {
  if (line.startsWith('# branch.oid ')) {
    const value = line.slice('# branch.oid '.length);
    // A repository with no commits reports the literal `(initial)`.
    return { ...branch, commit: value === '(initial)' ? null : value };
  }

  if (line.startsWith('# branch.head ')) {
    const value = line.slice('# branch.head '.length);
    return value === '(detached)'
      ? { ...branch, head: null, detached: true }
      : { ...branch, head: value, detached: false };
  }

  if (line.startsWith('# branch.upstream ')) {
    return { ...branch, upstream: line.slice('# branch.upstream '.length) };
  }

  if (line.startsWith('# branch.ab ')) {
    // Format: `+<ahead> -<behind>`.
    const match = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
    if (!match) {
      return branch;
    }
    return { ...branch, ahead: Number(match[1]), behind: Number(match[2]) };
  }

  return branch;
};

export const parseStatus = (stdout: string): ParsedStatus => {
  // Trailing NUL produces a final empty token; filtering here rather than trimming
  // avoids losing a legitimately empty record elsewhere.
  const tokens = stdout.split('\0');
  const files: GitFileStatus[] = [];
  let branch = emptyBranch;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token === '') {
      continue;
    }

    if (token.startsWith('# ')) {
      branch = parseBranchHeader(token, branch);
      continue;
    }

    const marker = token[0];

    if (marker === '?') {
      files.push({
        path: token.slice(2),
        staged: null,
        unstaged: 'untracked',
        conflicted: false,
      });
      continue;
    }

    if (marker === '!') {
      files.push({
        path: token.slice(2),
        staged: null,
        unstaged: 'ignored',
        conflicted: false,
      });
      continue;
    }

    if (marker === '1') {
      // `1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>`
      const fields = splitFields(token, 8);
      const xy = fields.head[1] ?? '..';
      files.push({
        path: fields.rest,
        staged: kindOf(xy[0]),
        unstaged: kindOf(xy[1]),
        conflicted: false,
      });
      continue;
    }

    if (marker === '2') {
      // `2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>` then a NUL and the
      // original path as the following token.
      const fields = splitFields(token, 9);
      const xy = fields.head[1] ?? '..';
      const originalPath = tokens[index + 1] ?? '';
      index += 1;

      files.push({
        path: fields.rest,
        staged: kindOf(xy[0]),
        unstaged: kindOf(xy[1]),
        originalPath,
        conflicted: false,
      });
      continue;
    }

    if (marker === 'u') {
      // `u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>`
      const fields = splitFields(token, 10);
      files.push({
        path: fields.rest,
        staged: null,
        unstaged: null,
        conflicted: true,
      });
      continue;
    }

    // An unrecognised record is skipped rather than throwing: a future git version
    // adding a record type must not blank the whole panel.
  }

  // Sorted by path so the changes view is stable between refreshes, independent of
  // the order git happened to emit.
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return { branch, files };
};

/**
 * Splits the leading `count` space-separated fields off a record, returning them plus
 * the untouched remainder.
 *
 * The remainder is a path, which may itself contain spaces — so the split has to be
 * bounded rather than a plain `split(' ')`.
 */
const splitFields = (record: string, count: number): { head: string[]; rest: string } => {
  const head: string[] = [];
  let cursor = 0;

  for (let field = 0; field < count; field += 1) {
    const next = record.indexOf(' ', cursor);
    if (next === -1) {
      head.push(record.slice(cursor));
      return { head, rest: '' };
    }
    head.push(record.slice(cursor, next));
    cursor = next + 1;
  }

  return { head, rest: record.slice(cursor) };
};
