import { describe, expect, it, vi } from 'vitest';
import { searchContent } from './contentSearch';

/**
 * Content search.
 *
 * The interesting assertions are the negative ones: what it refuses to do. Running an arbitrary
 * pattern, reading a 300 MB build artefact, filling the results with the bytes of a PNG, or
 * reporting a capped result set as if it were complete are each a way this feature becomes worse
 * than useless in the process the terminal shares.
 */

const files: Record<string, string> = {
  'src/index.ts': 'export const port = 8080;\nconsole.log("listening");\n',
  'src/app.ts': 'import { port } from "./index";\nexport const PORT_LABEL = "port";\n',
  'README.md': '# Demo\n\nRuns on a port.\n',
  'blob.bin': 'PNG\0\0\0IHDR port',
};

/** `path.join` uses the platform separator, so the fakes have to undo that before matching. */
const relativeOf = (absolute: string): string => absolute.replaceAll('\\', '/').replace('/w/', '');

const reader = (absolute: string): Promise<string> => {
  const text = files[relativeOf(absolute)];
  return text === undefined ? Promise.reject(new Error('ENOENT')) : Promise.resolve(text);
};

/** A reader over a flat map of file name to contents. */
const flatReader =
  (contents: Record<string, string>) =>
  (absolute: string): Promise<string> =>
    Promise.resolve(contents[relativeOf(absolute)] ?? '');

const run = (query: string, overrides = {}) =>
  searchContent({
    root: '/w',
    paths: Object.keys(files),
    query,
    readFileText: reader,
    ...overrides,
  });

describe('searchContent', () => {
  it('finds a literal substring and reports where', async () => {
    const result = await run('listening');

    expect(result.matches).toEqual([
      { path: 'src/index.ts', line: 2, column: 14, preview: 'console.log("listening");' },
    ]);
  });

  it('is case-insensitive', async () => {
    const result = await run('PORT');

    // Both the lower-case declaration and the upper-case constant.
    expect(result.matches.map((match) => match.path)).toContain('src/index.ts');
    expect(result.matches.map((match) => match.path)).toContain('src/app.ts');
  });

  it('reports every match in a file, not just the first', async () => {
    const result = await run('port');

    const inApp = result.matches.filter((match) => match.path === 'src/app.ts');
    // Line 1 imports it, line 2 mentions it twice — but a line is reported once, at its first
    // column, because a result list with the same line three times is noise.
    expect(inApp).toHaveLength(2);
  });

  it('treats the query as literal text, never as a pattern', async () => {
    /*
     * The security property, asserted rather than assumed. `.*` finding nothing is the point: a
     * renderer-supplied regular expression is a denial of service against the main process, so
     * the feature is not offered at all rather than offered with a guard someone can remove.
     */
    expect((await run('.*')).matches).toEqual([]);
    expect((await run('p.rt')).matches).toEqual([]);
    // And a query full of regex metacharacters is harmless rather than catastrophic.
    expect((await run('(a+)+$')).matches).toEqual([]);
  });

  it('skips a binary file rather than filling the results with its bytes', async () => {
    const result = await run('port');

    expect(result.matches.map((match) => match.path)).not.toContain('blob.bin');
  });

  it('skips a file larger than the limit', async () => {
    const big = { 'huge.log': `${'x'.repeat(5000)}port` };
    const result = await searchContent({
      root: '/w',
      paths: ['huge.log'],
      query: 'port',
      maxFileBytes: 1000,
      readFileText: flatReader(big),
    });

    // A minified bundle or a log is not code anyone reviews, and reading it costs the same as
    // reading the whole source tree.
    expect(result.matches).toEqual([]);
  });

  it('skips a file that vanished between indexing and searching', async () => {
    const result = await searchContent({
      root: '/w',
      paths: ['src/index.ts', 'deleted.ts'],
      query: 'port',
      readFileText: reader,
    });

    // An agent deleting a file mid-search is the normal case for this application, not an error.
    expect(result.matches).toHaveLength(1);
  });

  it('stops at the match limit and says so', async () => {
    const many = Object.fromEntries(
      Array.from({ length: 100 }, (_, index) => [`f${index}.ts`, 'port\n']),
    );
    const result = await searchContent({
      root: '/w',
      paths: Object.keys(many),
      query: 'port',
      maxMatches: 10,
      readFileText: flatReader(many),
    });

    expect(result.matches).toHaveLength(10);
    // A capped result set presented as complete is the one thing a search must never do.
    expect(result.truncated).toBe(true);
  });

  it('stops at the file limit and says so', async () => {
    const result = await run('nothing-matches-this', { maxFiles: 2 });

    expect(result.filesScanned).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('returns nothing for an empty query without reading anything', async () => {
    const readFileText = vi.fn(reader);

    const result = await searchContent({
      root: '/w',
      paths: Object.keys(files),
      query: '',
      readFileText,
    });

    expect(result.matches).toEqual([]);
    expect(readFileText).not.toHaveBeenCalled();
  });

  it('yields to the event loop while scanning', async () => {
    const yielded = vi.fn(() => Promise.resolve());
    const many = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [`f${index}.ts`, 'nothing here\n']),
    );

    await searchContent({
      root: '/w',
      paths: Object.keys(many),
      query: 'port',
      yieldEvery: 5,
      readFileText: flatReader(many),
      yieldToEventLoop: yielded,
    });

    // The claim behind invariant 8. A search that holds the event loop for its whole duration
    // freezes the terminal, and a large repository takes seconds.
    expect(yielded).toHaveBeenCalled();
  });

  it('abandons the search when superseded', async () => {
    const readFileText = vi.fn(reader);
    let reads = 0;

    const result = await searchContent({
      root: '/w',
      paths: Object.keys(files),
      query: 'port',
      readFileText,
      shouldContinue: () => {
        reads += 1;
        return reads <= 1;
      },
    });

    // "Latest query wins" has to abandon the *work*, not only drop the answer: a superseded
    // search that keeps reading files is a keystroke's worth of I/O per keystroke.
    expect(result.truncated).toBe(true);
    expect(readFileText.mock.calls.length).toBeLessThan(Object.keys(files).length);
  });

  it('trims a carriage return out of the preview', async () => {
    const result = await searchContent({
      root: '/w',
      paths: ['crlf.txt'],
      query: 'port',
      readFileText: () => Promise.resolve('a port here\r\nnext\r\n'),
    });

    expect(result.matches[0]?.preview).toBe('a port here');
  });

  it('bounds the preview length', async () => {
    const result = await searchContent({
      root: '/w',
      paths: ['min.js'],
      query: 'port',
      readFileText: () => Promise.resolve(`${'x'.repeat(4000)}port${'y'.repeat(4000)}`),
    });

    // A minified line would otherwise be 8 KB of payload per match, on a channel shared with
    // terminal output.
    expect(result.matches[0]?.preview.length ?? 0).toBeLessThanOrEqual(240);
  });
});
