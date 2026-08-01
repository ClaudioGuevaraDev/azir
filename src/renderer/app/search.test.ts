import { describe, expect, it } from 'vitest';
import { matchPaths } from './search';

/**
 * The path matcher.
 *
 * Ranking is the whole feature. A matcher that finds the file but puts it eleventh is a matcher
 * nobody uses, and the only way it fails is silently — the user scrolls, gives up, and goes back
 * to the tree.
 */

const PATHS = [
  'README.md',
  'package.json',
  'src/main/index.ts',
  'src/main/ipc/register.ts',
  'src/main/search/pathIndex.ts',
  'src/renderer/app/react.tsx',
  'src/renderer/app/reducer/index.ts',
  'src/renderer/overlays/OverlayHost.tsx',
  'src/renderer/viewer/CodeView.tsx',
  'src/shared/ipc/contracts.ts',
  'vendor/legacy/app.ts',
];

const found = (query: string): readonly string[] => matchPaths(PATHS, query).map((hit) => hit.path);

describe('matchPaths', () => {
  it('returns nothing for an empty query', () => {
    expect(matchPaths(PATHS, '')).toEqual([]);
    expect(matchPaths(PATHS, '   ')).toEqual([]);
  });

  it('finds an exact file name first', () => {
    expect(found('CodeView')[0]).toBe('src/renderer/viewer/CodeView.tsx');
  });

  it('is case-insensitive', () => {
    expect(found('codeview')[0]).toBe('src/renderer/viewer/CodeView.tsx');
    expect(found('README')[0]).toBe('README.md');
  });

  it('matches characters in order without requiring them to be adjacent', () => {
    // How someone types a path they half remember.
    expect(found('ovh')).toContain('src/renderer/overlays/OverlayHost.tsx');
    expect(found('apprct')).toContain('src/renderer/app/react.tsx');
  });

  it('does not match characters that appear out of order', () => {
    // The looseness is bounded by order; without that bound the matcher returns everything.
    expect(found('weiVedoC')).toEqual([]);
  });

  it('prefers a match in the file name over one spread across directories', () => {
    /*
     * `contracts.ts` contains the letters of `src` in order, and so does the directory prefix of
     * every path here. Ranking by span alone would bury a real file-name match under a dozen
     * incidental directory matches.
     */
    const hits = found('index');
    expect(hits[0]).toBe('src/main/index.ts');
  });

  it('breaks a tie by preferring the shorter path', () => {
    const hits = matchPaths(['src/app.ts', 'vendor/legacy/app.ts'], 'app.ts');
    expect(hits[0]?.path).toBe('src/app.ts');
  });

  it('prefers a tighter span', () => {
    const hits = matchPaths(['abcdefghijkz', 'akz'], 'akz');
    expect(hits[0]?.path).toBe('akz');
  });

  it('honours the result limit', () => {
    const many = Array.from({ length: 500 }, (_, index) => `src/file-${index}.ts`);

    // Bounded so the list renders instantly however large the workspace is.
    expect(matchPaths(many, 'src', 200)).toHaveLength(200);
  });

  it('handles a large index without pathological cost', () => {
    /*
     * Not a benchmark — a guard against an accidental quadratic. This runs on *every keystroke*
     * by design (the spec forbids IPC here), so the scan has to stay linear in the index.
     */
    const many = Array.from({ length: 50_000 }, (_, index) => `src/deep/nested/file-${index}.ts`);

    const started = performance.now();
    matchPaths(many, 'nestedfile');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
