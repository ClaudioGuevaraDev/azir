import { describe, expect, it, vi } from 'vitest';
import { createFileService, type RawEntry } from './fileService';

const file = (name: string): RawEntry => ({
  name,
  isDirectory: false,
  isSymbolicLink: false,
});

const directory = (name: string): RawEntry => ({
  name,
  isDirectory: true,
  isSymbolicLink: false,
});

const link = (name: string): RawEntry => ({
  name,
  isDirectory: false,
  isSymbolicLink: true,
});

const serviceFor = (entries: RawEntry[], isDirectoryTarget = async (): Promise<boolean> => false) =>
  createFileService({ readDirectory: async () => entries, isDirectoryTarget });

const list = async (entries: RawEntry[], relative = ''): Promise<string[]> => {
  const result = await serviceFor(entries).listDirectory('/abs', relative);
  if (!result.ok) {
    throw new Error(`expected success: ${result.error.code}`);
  }
  return result.value.map((entry) => entry.name);
};

describe('ordering', () => {
  it('puts directories before files', () => {
    // The tree is rebuilt on every refresh, so an order that came from readdir would
    // move rows under the cursor as the user reached for them.
    return expect(list([file('zeta.ts'), directory('alpha'), file('beta.ts')])).resolves.toEqual([
      'alpha',
      'beta.ts',
      'zeta.ts',
    ]);
  });

  it('sorts case-insensitively, so Readme sits with readme', async () => {
    expect(await list([file('Zoo.ts'), file('apple.ts'), file('Banana.ts')])).toEqual([
      'apple.ts',
      'Banana.ts',
      'Zoo.ts',
    ]);
  });

  it('breaks case-only ties deterministically', async () => {
    // Without the tiebreak, the order between README and readme would come from the
    // filesystem and differ between machines.
    const forwards = await list([file('README'), file('readme')]);
    const backwards = await list([file('readme'), file('README')]);

    expect(forwards).toEqual(backwards);
  });

  it('is stable across repeated listings', async () => {
    const entries = [file('b'), directory('a'), file('A'), directory('B')];

    expect(await list(entries)).toEqual(await list(entries));
  });
});

describe('identity', () => {
  it('gives each entry a workspace-relative path', async () => {
    const result = await serviceFor([file('index.ts')]).listDirectory('/abs/src', 'src');
    if (!result.ok) {
      throw new Error('unreachable');
    }

    expect(result.value[0]).toEqual({ path: 'src/index.ts', name: 'index.ts', kind: 'file' });
  });

  it('does not prefix a separator at the root', async () => {
    const result = await serviceFor([file('package.json')]).listDirectory('/abs', '');
    if (!result.ok) {
      throw new Error('unreachable');
    }

    expect(result.value[0]?.path).toBe('package.json');
  });
});

describe('ignoring', () => {
  it('filters ignored directories out of the listing', async () => {
    // Filtered in the service, not the UI, so the scanner and watcher agree.
    expect(await list([directory('node_modules'), directory('src'), directory('.git')])).toEqual([
      'src',
    ]);
  });

  it('filters by full path, so a nested ignore is caught', async () => {
    expect(await list([directory('node_modules')], 'packages/app')).toEqual([]);
  });
});

describe('symlinks', () => {
  it('treats a link to a directory as a directory', async () => {
    const service = serviceFor([link('linked')], async () => true);

    const result = await service.listDirectory('/abs', '');
    if (!result.ok) {
      throw new Error('unreachable');
    }
    expect(result.value[0]?.kind).toBe('directory');
  });

  it('treats a broken link as a file rather than an unopenable directory', async () => {
    const service = createFileService({
      readDirectory: async () => [link('dangling')],
      isDirectoryTarget: async () => {
        throw new Error('ENOENT');
      },
    });

    const result = await service.listDirectory('/abs', '');
    if (!result.ok) {
      throw new Error('unreachable');
    }
    expect(result.value[0]?.kind).toBe('file');
  });

  it('does not stat non-symlink entries', async () => {
    // One syscall per directory, not per entry: a large directory would otherwise
    // cost thousands of stats just to draw a list of names.
    const isDirectoryTarget = vi.fn(async () => false);
    const service = createFileService({
      readDirectory: async () => [file('a'), file('b'), directory('c')],
      isDirectoryTarget,
    });

    await service.listDirectory('/abs', '');

    expect(isDirectoryTarget).not.toHaveBeenCalled();
  });
});

describe('writing', () => {
  const writerCapturing = () => {
    const written: Array<{ path: string; text: string }> = [];
    const service = createFileService({
      writeFileBytes: async (target, bytes) => {
        written.push({ path: target, text: bytes.toString('utf8') });
      },
    });
    return { service, written };
  };

  it('writes LF when the file used LF', async () => {
    const { service, written } = writerCapturing();

    await service.writeFile('/abs/a.txt', 'a.txt', {
      content: 'one\ntwo\n',
      eol: 'lf',
      hadBom: false,
    });

    expect(written[0]?.text).toBe('one\ntwo\n');
  });

  it('restores CRLF when the file used CRLF', async () => {
    // Rewriting a CRLF file with LF turns a one-line edit into a whole-file diff, which for a
    // tool whose purpose is reviewing changes is close to the worst possible behaviour.
    const { service, written } = writerCapturing();

    await service.writeFile('/abs/a.txt', 'a.txt', {
      content: 'one\ntwo\n',
      eol: 'crlf',
      hadBom: false,
    });

    expect(written[0]?.text).toBe('one\r\ntwo\r\n');
  });

  it('falls back to LF for a file that was mixed', async () => {
    const { service, written } = writerCapturing();

    await service.writeFile('/abs/a.txt', 'a.txt', {
      content: 'one\ntwo',
      eol: 'mixed',
      hadBom: false,
    });

    expect(written[0]?.text).toBe('one\ntwo');
  });

  it('restores a byte-order mark that was there, and adds none that was not', async () => {
    const { service, written } = writerCapturing();

    await service.writeFile('/abs/a.txt', 'a.txt', {
      content: 'x',
      eol: 'lf',
      hadBom: true,
    });
    await service.writeFile('/abs/b.txt', 'b.txt', {
      content: 'x',
      eol: 'lf',
      hadBom: false,
    });

    expect(written[0]?.text).toBe('﻿x');
    expect(written[1]?.text).toBe('x');
  });

  it('reports the byte size actually written', async () => {
    const { service } = writerCapturing();

    const result = await service.writeFile('/abs/a.txt', 'a.txt', {
      content: 'año',
      eol: 'lf',
      hadBom: false,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('unreachable');
    }
    // Four bytes, three characters: the size is bytes, not string length.
    expect(result.value.byteSize).toBe(4);
  });

  it('serialises concurrent writes to the same file', async () => {
    // Interleaved writes produce a mixture of both versions, which is a corrupted file rather
    // than a stale one.
    let concurrent = 0;
    let peak = 0;
    const service = createFileService({
      writeFileBytes: async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setImmediate(resolve));
        concurrent -= 1;
      },
    });

    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        service.writeFile('/abs/same.txt', 'same.txt', {
          content: `v${index}`,
          eol: 'lf',
          hadBom: false,
        }),
      ),
    );

    expect(peak).toBe(1);
  });

  it.each([
    ['EACCES', 'permission-denied'],
    ['EPERM', 'permission-denied'],
    ['EROFS', 'permission-denied'],
    ['ENOENT', 'not-found'],
    ['ENOSPC', 'internal'],
  ])('maps a %s failure to %s rather than throwing', async (code, expected) => {
    const service = createFileService({
      writeFileBytes: async () => {
        throw Object.assign(new Error(code), { code });
      },
    });

    const result = await service.writeFile('/abs/a.txt', 'a.txt', {
      content: 'x',
      eol: 'lf',
      hadBom: false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.error.code).toBe(expected);
  });
});

describe('failures become state', () => {
  const failWith = (code: string) =>
    createFileService({
      readDirectory: async () => {
        throw Object.assign(new Error(code), { code });
      },
    });

  it.each([
    ['ENOENT', 'not-found'],
    ['EACCES', 'permission-denied'],
    ['EPERM', 'permission-denied'],
    ['ENOTDIR', 'not-a-file'],
  ])('maps %s to %s', async (code, expected) => {
    const result = await failWith(code).listDirectory('/abs', 'src');

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.error.code).toBe(expected);
  });

  it('falls back to internal for an unrecognised code', async () => {
    const result = await failWith('EMFILE').listDirectory('/abs', 'src');

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.error.code).toBe('internal');
  });

  it('never throws, so one unreadable folder cannot take the panel down', async () => {
    await expect(failWith('EACCES').listDirectory('/abs', 'src')).resolves.toBeDefined();
  });
});
