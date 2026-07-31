import { describe, expect, it } from 'vitest';
import { parseDiff } from './parseDiff';

const options = { path: 'src/index.ts', target: 'worktree' as const };

const diff = (...lines: string[]): string => `${lines.join('\n')}\n`;

const PREAMBLE = [
  'diff --git a/src/index.ts b/src/index.ts',
  'index 1a2b3c4..5d6e7f8 100644',
  '--- a/src/index.ts',
  '+++ b/src/index.ts',
];

describe('line numbering', () => {
  it('numbers both sides from the hunk header', () => {
    const result = parseDiff(
      diff(...PREAMBLE, '@@ -10,3 +10,4 @@', ' context', '-removed', '+added', '+also', ' tail'),
      options,
    );

    // An addition advances only the new side; a removal only the old. Getting this wrong
    // makes every number after the first change incorrect.
    expect(
      result.hunks[0]?.lines.map((line) => [line.kind, line.oldNumber, line.newNumber]),
    ).toEqual([
      ['context', 10, 10],
      ['remove', 11, null],
      ['add', null, 11],
      ['add', null, 12],
      ['context', 12, 13],
    ]);
  });

  it('restarts numbering in each hunk', () => {
    const result = parseDiff(
      diff(
        ...PREAMBLE,
        '@@ -1,1 +1,1 @@',
        '-first',
        '+FIRST',
        '@@ -50,1 +50,1 @@',
        '-second',
        '+SECOND',
      ),
      options,
    );

    expect(result.hunks).toHaveLength(2);
    expect(result.hunks[1]?.lines[0]?.oldNumber).toBe(50);
    expect(result.hunks[1]?.lines[1]?.newNumber).toBe(50);
  });

  it('treats an omitted count as one line, not zero', () => {
    // `@@ -1 +1 @@` is what git emits for a single-line hunk.
    const result = parseDiff(diff(...PREAMBLE, '@@ -1 +1 @@', '-a', '+b'), options);

    expect(result.hunks[0]).toMatchObject({ oldLines: 1, newLines: 1 });
  });

  it('reads the counts when present', () => {
    const result = parseDiff(diff(...PREAMBLE, '@@ -3,7 +3,9 @@', ' x'), options);

    expect(result.hunks[0]).toMatchObject({
      oldStart: 3,
      oldLines: 7,
      newStart: 3,
      newLines: 9,
    });
  });
});

describe('hunk headings', () => {
  it('captures the trailing context git puts after the markers', () => {
    const result = parseDiff(
      diff(...PREAMBLE, '@@ -1,2 +1,2 @@ export const createStore = () => {', ' a', '-b', '+c'),
      options,
    );

    expect(result.hunks[0]?.heading).toBe('export const createStore = () => {');
  });

  it('leaves the heading empty when there is none', () => {
    const result = parseDiff(diff(...PREAMBLE, '@@ -1,1 +1,1 @@', '-a', '+b'), options);

    expect(result.hunks[0]?.heading).toBe('');
  });
});

describe('content edge cases', () => {
  it('keeps a blank context line', () => {
    // git emits these as a single space; a parser that required content after the marker
    // would silently drop every blank line and misalign everything below.
    const result = parseDiff(diff(...PREAMBLE, '@@ -1,3 +1,3 @@', ' a', ' ', '-b', '+c'), options);

    expect(result.hunks[0]?.lines[1]).toMatchObject({ kind: 'context', text: '' });
  });

  it('accepts a blank context line that arrived with its space stripped', () => {
    const result = parseDiff(diff(...PREAMBLE, '@@ -1,3 +1,3 @@', ' a', '', '-b', '+c'), options);

    expect(result.hunks[0]?.lines[1]).toMatchObject({ kind: 'context', text: '' });
    expect(result.hunks[0]?.lines).toHaveLength(4);
  });

  it('does not invent a trailing blank line from the final newline', () => {
    const result = parseDiff(diff(...PREAMBLE, '@@ -1,1 +1,1 @@', '-a', '+b'), options);

    expect(result.hunks[0]?.lines).toHaveLength(2);
  });

  it('preserves leading whitespace in content', () => {
    const result = parseDiff(
      diff(...PREAMBLE, '@@ -1,1 +1,1 @@', '-    indented old', '+      indented new'),
      options,
    );

    expect(result.hunks[0]?.lines[0]?.text).toBe('    indented old');
    expect(result.hunks[0]?.lines[1]?.text).toBe('      indented new');
  });

  it('handles a line whose content starts with a plus or minus', () => {
    const result = parseDiff(diff(...PREAMBLE, '@@ -1,1 +1,1 @@', '--old', '++new'), options);

    expect(result.hunks[0]?.lines[0]).toMatchObject({ kind: 'remove', text: '-old' });
    expect(result.hunks[0]?.lines[1]).toMatchObject({ kind: 'add', text: '+new' });
  });

  it('parses CRLF output identically to LF', () => {
    const crlf = [...PREAMBLE, '@@ -1,1 +1,1 @@', '-a', '+b'].join('\r\n') + '\r\n';

    const result = parseDiff(crlf, options);

    expect(result.hunks[0]?.lines.map((line) => line.text)).toEqual(['a', 'b']);
  });
});

describe('no newline at end of file', () => {
  it('attaches the marker to the line above rather than making it a line', () => {
    const result = parseDiff(
      diff(...PREAMBLE, '@@ -1,1 +1,1 @@', '-old', '\\ No newline at end of file', '+new'),
      options,
    );

    expect(result.hunks[0]?.lines).toHaveLength(2);
    expect(result.hunks[0]?.lines[0]).toMatchObject({ text: 'old', noNewline: true });
    expect(result.hunks[0]?.lines[1]?.noNewline).toBeUndefined();
  });

  it('handles the marker on the last line of the diff', () => {
    const result = parseDiff(
      diff(...PREAMBLE, '@@ -1,1 +1,1 @@', '-old', '+new', '\\ No newline at end of file'),
      options,
    );

    expect(result.hunks[0]?.lines[1]).toMatchObject({ text: 'new', noNewline: true });
  });
});

describe('binary files', () => {
  it('reports a binary difference without hunks', () => {
    const result = parseDiff(
      diff('diff --git a/logo.png b/logo.png', 'Binary files a/logo.png and b/logo.png differ'),
      options,
    );

    expect(result).toMatchObject({ binary: true, hunks: [] });
  });

  it('recognises a full binary patch too', () => {
    const result = parseDiff(
      diff('diff --git a/logo.png b/logo.png', 'GIT binary patch', 'delta 123'),
      options,
    );

    expect(result.binary).toBe(true);
  });
});

describe('empty and malformed input', () => {
  it('returns no hunks for identical content', () => {
    const result = parseDiff('', options);

    expect(result).toEqual({ path: 'src/index.ts', target: 'worktree', binary: false, hunks: [] });
  });

  it('ignores the preamble', () => {
    const result = parseDiff(diff(...PREAMBLE), options);

    expect(result.hunks).toEqual([]);
  });

  it('ignores content before the first hunk header', () => {
    const result = parseDiff(diff('some noise', '+not in a hunk'), options);

    expect(result.hunks).toEqual([]);
  });

  it('carries the requested path and target through', () => {
    const result = parseDiff(diff(...PREAMBLE, '@@ -1,1 +1,1 @@', '-a', '+b'), {
      path: 'docs/notes.md',
      target: 'staged',
    });

    expect(result).toMatchObject({ path: 'docs/notes.md', target: 'staged' });
  });
});

describe('a realistic multi-hunk diff', () => {
  it('parses every hunk and counts the changes', () => {
    const result = parseDiff(
      diff(
        ...PREAMBLE,
        '@@ -1,6 +1,7 @@ import { useState } from "react";',
        ' import { useState } from "react";',
        ' ',
        '-export const old = 1;',
        '+export const renamed = 1;',
        '+export const added = 2;',
        ' ',
        ' export const kept = 3;',
        '@@ -40,4 +41,3 @@ export const tail = () => {',
        ' export const tail = () => {',
        '-  removedOne();',
        '-  removedTwo();',
        '+  replacement();',
        ' };',
      ),
      options,
    );

    expect(result.hunks).toHaveLength(2);
    const all = result.hunks.flatMap((hunk) => hunk.lines);
    expect(all.filter((line) => line.kind === 'add')).toHaveLength(3);
    expect(all.filter((line) => line.kind === 'remove')).toHaveLength(3);
    expect(result.hunks[1]?.heading).toBe('export const tail = () => {');
  });
});
