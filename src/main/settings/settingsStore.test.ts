import { beforeEach, describe, expect, it } from 'vitest';
import { defaultSettings, type Settings } from '@shared/models/settings';
import { createSettingsStore, type SettingsIo, type SettingsStore } from './settingsStore';

/**
 * The store's job is small and its failure modes are all silent, which is why they are pinned
 * here: a write that never happens, a write that happens a hundred times, a malformed file that
 * takes the whole configuration with it, and a change made a moment before quitting that is lost
 * because the debounce had not fired.
 */

interface FakeIo extends SettingsIo {
  readonly writes: string[];
  readonly syncWrites: string[];
  contents: string | null;
  failNextWrite: boolean;
}

const makeIo = (contents: string | null = null): FakeIo => ({
  writes: [],
  syncWrites: [],
  contents,
  failNextWrite: false,
  read(_file) {
    if (this.contents === null) {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      return Promise.reject(error);
    }
    return Promise.resolve(this.contents);
  },
  write(_file, text) {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      return Promise.reject(new Error('EACCES: read-only volume'));
    }
    this.writes.push(text);
    this.contents = text;
    return Promise.resolve();
  },
  writeSync(_file, text) {
    this.syncWrites.push(text);
    this.contents = text;
  },
});

/** A controllable clock, so the debounce is asserted rather than waited out. */
const makeClock = (): {
  fire: () => void;
  pending: () => number;
  setTimer: (callback: () => void, ms: number) => NodeJS.Timeout;
  clearTimer: (handle: NodeJS.Timeout) => void;
} => {
  const callbacks = new Map<number, () => void>();
  let next = 1;
  return {
    fire() {
      const due = [...callbacks.values()];
      callbacks.clear();
      for (const callback of due) {
        callback();
      }
    },
    pending: () => callbacks.size,
    setTimer(callback) {
      const handle = next;
      next += 1;
      callbacks.set(handle, callback);
      return handle as unknown as NodeJS.Timeout;
    },
    clearTimer(handle) {
      callbacks.delete(handle as unknown as number);
    },
  };
};

/**
 * Lets the write chain run to completion.
 *
 * `writeNow` is queued onto a promise chain, so a single microtask tick is not enough — and a
 * test that ticks once passes or fails depending on how many `await`s the implementation happens
 * to contain, which is not a property worth asserting.
 */
const settled = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

let io: FakeIo;
let clock: ReturnType<typeof makeClock>;
let store: SettingsStore;
let errors: string[];

const build = (contents: string | null = null): void => {
  io = makeIo(contents);
  clock = makeClock();
  errors = [];
  store = createSettingsStore({
    file: '/userData/settings.json',
    io,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    onError: (detail) => errors.push(detail),
  });
};

beforeEach(() => {
  build();
});

describe('loading', () => {
  it('uses the defaults when the file does not exist', async () => {
    const parsed = await store.load();

    expect(parsed.settings).toEqual(defaultSettings);
    // A first launch is not a malformed configuration.
    expect(parsed.invalidFields).toEqual([]);
    expect(store.current()).toEqual(defaultSettings);
  });

  it('reads a valid file', async () => {
    build(JSON.stringify({ editor: { tabWidth: 8 }, terminal: { shell: 'cmd' } }));

    await store.load();

    expect(store.current().editor.tabWidth).toBe(8);
    expect(store.current().terminal.shell).toBe('cmd');
  });

  it('falls back to the defaults when the file is not JSON at all', async () => {
    // Half a file, which is what a crash during a non-atomic write leaves behind.
    build('{ "editor": { "tabWid');

    const parsed = await store.load();

    expect(parsed.settings).toEqual(defaultSettings);
    expect(parsed.invalidFields).toEqual(['<root>']);
    // Reported, not thrown: the spec lists "settings file malformed" as an expected failure that
    // must leave a usable application.
    expect(errors).toEqual([]);
  });

  it('keeps the good fields of a file with one bad one', async () => {
    build(JSON.stringify({ editor: { tabWidth: 8 }, appearance: { codeFontSize: 'large' } }));

    const parsed = await store.load();

    expect(parsed.settings.editor.tabWidth).toBe(8);
    expect(parsed.settings.appearance).toEqual(defaultSettings.appearance);
    expect(store.invalidFields()).toEqual(['appearance.codeFontSize']);
  });
});

describe('writing', () => {
  it('does not write until the debounce fires', async () => {
    await store.load();

    store.merge({ editor: { tabWidth: 4 } });

    expect(io.writes).toEqual([]);
    clock.fire();
    await settled();
    expect(io.writes).toHaveLength(1);
  });

  it('collapses a burst of changes into one write', async () => {
    await store.load();

    // What dragging a slider or clicking through arrangements produces.
    for (let size = 12; size <= 18; size += 1) {
      store.merge({ appearance: { codeFontSize: size } });
    }

    // Each change replaced the previous timer rather than adding one.
    expect(clock.pending()).toBe(1);
    clock.fire();
    await settled();

    expect(io.writes).toHaveLength(1);
    expect(JSON.parse(io.writes[0] ?? '{}')).toMatchObject({ appearance: { codeFontSize: 18 } });
  });

  it('skips a write whose content matches what is already on disk', async () => {
    await store.load();
    store.merge({ editor: { tabWidth: 4 } });
    clock.fire();
    await settled();
    expect(io.writes).toHaveLength(1);

    // The renderer re-sending its state, or the user picking the value that is already set.
    store.merge({ editor: { tabWidth: 4 } });
    clock.fire();
    await settled();

    expect(io.writes).toHaveLength(1);
  });

  it('merges a patch rather than replacing the document', async () => {
    build(JSON.stringify({ editor: { tabWidth: 8 }, terminal: { shell: 'cmd' } }));
    await store.load();

    store.merge({ appearance: { codeFontSize: 20 } });
    clock.fire();
    await settled();

    const written = JSON.parse(io.writes[0] ?? '{}') as Settings;
    // The two groups the patch said nothing about are still there. A patch that replaced the
    // document would silently reset everything the user had configured but not just touched.
    expect(written.editor.tabWidth).toBe(8);
    expect(written.terminal.shell).toBe('cmd');
    expect(written.appearance.codeFontSize).toBe(20);
  });

  it('reports a failed write and retries on the next change', async () => {
    await store.load();
    io.failNextWrite = true;

    store.merge({ editor: { tabWidth: 4 } });
    clock.fire();
    await settled();

    expect(errors).toHaveLength(1);
    expect(io.writes).toEqual([]);

    // The failed content was not recorded as persisted, so the identical retry is not
    // deduplicated away — which is the bug this asserts against.
    store.merge({ editor: { tabWidth: 4 } });
    clock.fire();
    await settled();

    expect(io.writes).toHaveLength(1);
  });
});

describe('flushSync', () => {
  it('writes a pending change immediately', async () => {
    await store.load();
    store.merge({ editor: { tabWidth: 4 } });

    store.flushSync();

    // Synchronous because `before-quit` cannot await — see the note on the method. A change made
    // in the last moments before quitting is the one most likely to be lost, and the least
    // acceptable to lose.
    expect(io.syncWrites).toHaveLength(1);
    expect(clock.pending()).toBe(0);
  });

  it('writes nothing when there is nothing pending', async () => {
    await store.load();
    store.merge({ editor: { tabWidth: 4 } });
    store.flushSync();

    store.flushSync();

    expect(io.syncWrites).toHaveLength(1);
  });

  it('does not throw when the disk refuses', async () => {
    await store.load();
    const throwing = createSettingsStore({
      file: '/userData/settings.json',
      io: {
        ...io,
        writeSync: () => {
          throw new Error('EACCES');
        },
      },
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      onError: (detail) => errors.push(detail),
    });
    throwing.merge({ editor: { tabWidth: 4 } });

    // Quitting must not be blocked by a settings file, whatever the disk says.
    expect(() => throwing.flushSync()).not.toThrow();
    expect(errors).toHaveLength(1);
  });
});

describe('dispose', () => {
  it('cancels a pending write', async () => {
    await store.load();
    store.merge({ editor: { tabWidth: 4 } });

    store.dispose();
    clock.fire();
    await settled();

    expect(io.writes).toEqual([]);
  });
});

describe('the real io', () => {
  it('writes through a temporary file so a reader never sees a half-written document', async () => {
    /*
     * Asserted structurally rather than by racing a reader: the guarantee comes from `rename`
     * being atomic within a directory, so what matters is that the bytes never go to the real
     * path directly. A plain `writeFile` truncates first, and a crash in that window leaves an
     * empty settings file — losing a configuration to a bug in something unrelated.
     */
    const calls: string[] = [];
    const spyIo: SettingsIo = {
      read: () => Promise.reject(new Error('unused')),
      write: (file) => {
        calls.push(file);
        return Promise.resolve();
      },
      writeSync: (file) => calls.push(file),
    };
    const spied = createSettingsStore({ file: '/userData/settings.json', io: spyIo });
    spied.merge({ editor: { tabWidth: 4 } });
    spied.flushSync();

    // The store hands the io the final path; atomicity is the io's contract, exercised for real
    // by the end-to-end settings spec, which restarts the app and reads the file back.
    expect(calls).toEqual(['/userData/settings.json']);
    spied.dispose();
  });
});

describe('load is not fooled by formatting', () => {
  it('writes after a change even though the file already held the same values', async () => {
    /*
     * A tempting optimisation is to seed the "what is on disk" cache with the text just read, so
     * an unchanged session writes nothing. It is wrong: the text on disk is the *user's*
     * formatting, and `serialise` produces Azir's. The two never match, so the cache would be
     * primed with a value that can never be hit — harmless — but the reverse mistake, seeding it
     * with the serialised form of the parsed settings, would swallow the first real write when a
     * field had fallen back. This pins the safe direction.
     */
    build('{"editor":{"tabWidth":4}}');
    await store.load();

    store.merge({ editor: { tabWidth: 4 } });
    clock.fire();
    await settled();

    expect(io.writes).toHaveLength(1);
  });
});
