import type { DiffHunk, DiffLine, DiffTarget, FileDiff } from '@shared/ipc/contracts';

/**
 * Parses the unified diff of a single path.
 *
 * The invocation is fixed (`--no-color --no-ext-diff --unified=<n>`, one pathspec), so
 * this parser deliberately does not handle everything `git diff` can emit — no
 * multi-file output, no combined diffs from a merge, no rename headers, because the
 * caller asks about one path at a time. Narrowing the input is what keeps it small
 * enough to be obviously correct.
 *
 * The cases that do have to be right, and are easy to get wrong:
 *
 *  - **Line numbers on both sides.** Each hunk restarts them from its `@@` header, and
 *    an addition advances only the new side while a removal advances only the old. Get
 *    this wrong and every line number after the first hunk is off.
 *  - **`\ No newline at end of file`.** It is a marker attached to the *previous* line,
 *    not a line of its own. Treating it as content puts a stray backslash in the view.
 *  - **A single-line hunk omits its count**: `@@ -1 +1 @@` means one line, not zero.
 *  - **A context line that is genuinely empty** arrives as `""`, not `" "`, because git
 *    does not pad it. Requiring the leading space would drop blank lines.
 *  - **Binary files** produce a sentence instead of hunks.
 */

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export interface ParseDiffOptions {
  readonly path: string;
  readonly target: DiffTarget;
}

export const parseDiff = (stdout: string, options: ParseDiffOptions): FileDiff => {
  const base = { path: options.path, target: options.target };

  if (stdout === '') {
    // No output means no difference. An empty hunk list is the honest representation;
    // the viewer decides what to say about it.
    return { ...base, binary: false, hunks: [] };
  }

  if (/^Binary files .* differ$/m.test(stdout) || stdout.includes('GIT binary patch')) {
    return { ...base, binary: true, hunks: [] };
  }

  const hunks: DiffHunk[] = [];
  let current: { header: Omit<DiffHunk, 'lines'>; lines: DiffLine[] } | undefined;
  let oldNumber = 0;
  let newNumber = 0;

  const finish = (): void => {
    if (current) {
      hunks.push({ ...current.header, lines: current.lines });
      current = undefined;
    }
  };

  // Every diff line, including the last, is newline-terminated, so splitting the raw
  // output would leave a trailing empty element. That artefact has to go before the
  // loop, because an empty line inside a hunk is a legitimate blank context line and
  // the loop cannot tell the two apart.
  const body = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;

  // Split on \n and strip a trailing \r, so a diff produced with CRLF line endings in
  // the pipe parses the same as one with LF.
  for (const raw of body.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

    const match = HUNK_HEADER.exec(line);
    if (match) {
      finish();
      oldNumber = Number(match[1]);
      newNumber = Number(match[3]);
      current = {
        header: {
          oldStart: oldNumber,
          // An absent count means exactly one line, not none.
          oldLines: match[2] === undefined ? 1 : Number(match[2]),
          newStart: newNumber,
          newLines: match[4] === undefined ? 1 : Number(match[4]),
          heading: (match[5] ?? '').trim(),
        },
        lines: [],
      };
      continue;
    }

    if (!current) {
      // Everything before the first hunk is the `diff --git`, `index`, `---` and `+++`
      // preamble, which carries nothing the viewer needs.
      continue;
    }

    if (line.startsWith('\\')) {
      // `\ No newline at end of file` describes the line above it.
      const previous = current.lines[current.lines.length - 1];
      if (previous) {
        current.lines[current.lines.length - 1] = { ...previous, noNewline: true };
      }
      continue;
    }

    const marker = line[0];
    const text = line.slice(1);

    if (marker === '+') {
      current.lines.push({ kind: 'add', text, oldNumber: null, newNumber });
      newNumber += 1;
      continue;
    }

    if (marker === '-') {
      current.lines.push({ kind: 'remove', text, oldNumber, newNumber: null });
      oldNumber += 1;
      continue;
    }

    if (marker === ' ' || line === '') {
      // A blank context line arrives as an empty string: git does not pad it, so
      // requiring the leading space here would silently drop every blank line.
      current.lines.push({ kind: 'context', text, oldNumber, newNumber });
      oldNumber += 1;
      newNumber += 1;
      continue;
    }

    // Anything else is trailing noise after the last hunk.
  }

  finish();
  return { ...base, binary: false, hunks };
};
