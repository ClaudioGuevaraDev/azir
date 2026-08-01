import { describe, expect, it, vi } from 'vitest';
import { buildPathIndex, type DirectoryChild } from './pathIndex';

/**
 * The walk.
 *
 * Its three obligations are all invisible when they work and expensive when they do not: it must
 * yield to the event loop, it must stop at a limit, and it must agree with the ignore list the
 * scanner and the watcher share.
 */

type Tree = Record<string, readonly DirectoryChild[]>;

const file = (name: string): DirectoryChild => ({ name, isDirectory: false });
const dir = (name: string): DirectoryChild => ({ name, isDirectory: true });

/** A fake filesystem keyed by the path the walker asks for, with `/` as the root. */
const reader =
  (tree: Tree) =>
  (absolute: string): Promise<readonly DirectoryChild[]> => {
    const key = absolute.replaceAll('\\', '/');
    const children = tree[key];
    if (children === undefined) {
      return Promise.reject(new Error(`ENOENT: ${key}`));
    }
    return Promise.resolve(children);
  };

const TREE: Tree = {
  '/w': [dir('src'), dir('node_modules'), dir('.git'), file('README.md')],
  '/w/src': [dir('main'), file('index.ts')],
  '/w/src/main': [file('app.ts'), file('ipc.ts')],
  '/w/node_modules': [file('should-never-be-read.js')],
  '/w/.git': [file('HEAD')],
};

describe('buildPathIndex', () => {
  it('lists every file, workspace-relative and POSIX', async () => {
    const index = await buildPathIndex('/w', { readDirectory: reader(TREE) });

    expect([...index.paths].sort()).toEqual([
      'README.md',
      'src/index.ts',
      'src/main/app.ts',
      'src/main/ipc.ts',
    ]);
    expect(index.truncated).toBe(false);
  });

  it('lists no directories', async () => {
    const index = await buildPathIndex('/w', { readDirectory: reader(TREE) });

    // A directory is not something search can open, and offering one as a result means a click
    // that does nothing.
    expect(index.paths).not.toContain('src');
  });

  it('never descends into an ignored directory', async () => {
    const readDirectory = vi.fn(reader(TREE));

    await buildPathIndex('/w', { readDirectory });

    const visited = readDirectory.mock.calls.map(([absolute]) => absolute);
    // Not merely absent from the results — never read at all. `node_modules` is the difference
    // between a walk that takes 40 ms and one that takes a minute.
    expect(visited).not.toContain('/w/node_modules');
    expect(visited).not.toContain('/w/.git');
  });

  it('skips a directory it cannot read rather than failing the whole walk', async () => {
    const tree: Tree = {
      '/w': [dir('readable'), dir('locked'), file('top.txt')],
      '/w/readable': [file('inside.txt')],
      // `/w/locked` is absent, so the reader rejects.
    };

    const index = await buildPathIndex('/w', { readDirectory: reader(tree) });

    // A permission error, or a directory an agent deleted mid-walk. Both are ordinary.
    expect([...index.paths].sort()).toEqual(['readable/inside.txt', 'top.txt']);
  });

  it('stops at the limit and says so', async () => {
    const tree: Tree = {
      '/w': Array.from({ length: 50 }, (_, index) => file(`f${index}.ts`)),
    };

    const index = await buildPathIndex('/w', { readDirectory: reader(tree), limit: 10 });

    expect(index.paths).toHaveLength(10);
    // Said, not hidden: with this true, a path genuinely may be missing from search.
    expect(index.truncated).toBe(true);
  });

  it('yields to the event loop while walking', async () => {
    const yielded = vi.fn(() => Promise.resolve());
    const tree: Tree = {
      '/w': Array.from({ length: 100 }, (_, index) => file(`f${index}.ts`)),
    };

    await buildPathIndex('/w', {
      readDirectory: reader(tree),
      yieldEvery: 10,
      yieldToEventLoop: yielded,
    });

    // Invariant 8: "PTY traffic never waits behind git, search or filesystem scans." A walk that
    // never yields blocks main for its whole duration, and the terminal freezes with it.
    expect(yielded).toHaveBeenCalled();
  });

  it('abandons the walk when told to stop', async () => {
    const readDirectory = vi.fn(
      reader({
        '/w': [dir('a'), dir('b'), dir('c')],
        '/w/a': [file('one.ts')],
        '/w/b': [file('two.ts')],
        '/w/c': [file('three.ts')],
      }),
    );
    let calls = 0;

    const index = await buildPathIndex('/w', {
      readDirectory,
      shouldContinue: () => {
        calls += 1;
        return calls <= 2;
      },
    });

    // The workspace closed, or a second one opened. Either way the rest of the walk is wasted
    // work in the process the terminal shares.
    expect(index.truncated).toBe(true);
    expect(readDirectory.mock.calls.length).toBeLessThan(4);
  });

  it('walks a deep tree without recursing into the stack', async () => {
    /*
     * 1,200 levels rather than something enormous. The walk is iterative, so the depth it can
     * survive is bounded by memory rather than by the call stack — but building the *path* for
     * each level is inherently quadratic in the depth, and a test with tens of thousands of
     * levels spends seconds in `path.join` proving nothing extra. This clears a recursive
     * implementation's comfortable range while staying cheap.
     */
    const depth = 1_200;
    const tree: Tree = { '/w': [dir('d0')] };
    let current = '/w/d0';
    for (let level = 0; level < depth; level += 1) {
      tree[current] = level === depth - 1 ? [file('bottom.txt')] : [dir(`d${level + 1}`)];
      current = `${current}/d${level + 1}`;
    }

    const index = await buildPathIndex('/w', { readDirectory: reader(tree) });

    expect(index.paths).toHaveLength(1);
  });

  it('does not follow a symlinked directory', async () => {
    /*
     * The property that makes an unbounded depth unreachable in the first place, and it comes from
     * the reader rather than the walk: `readdir(withFileTypes)` reports a symlink as a symlink,
     * so `isDirectory` is false and the entry is recorded as a file. A link pointing back up the
     * tree therefore cannot make the walk go in circles — the same guarantee the watcher gets
     * from `followSymlinks: false`.
     */
    const index = await buildPathIndex('/w', {
      readDirectory: reader({
        '/w': [file('link-to-root'), file('real.txt')],
      }),
    });

    expect([...index.paths].sort()).toEqual(['link-to-root', 'real.txt']);
  });
});
