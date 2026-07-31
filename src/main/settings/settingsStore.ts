import { mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describeError } from '@shared/ipc/result';
import {
  defaultSettings,
  parseSettings,
  type ParsedSettings,
  type Settings,
} from '@shared/models/settings';

/**
 * Owns the settings file.
 *
 * docs/architecture.md gives this module three requirements and they pull in different
 * directions:
 *
 *  1. "Settings are loaded by the main process at startup." So loading happens once, before the
 *     window exists, and the renderer is handed a value rather than a file path.
 *  2. "Malformed configuration falls back per field." Handled by `parseSettings`; this module's
 *     part is to make sure a file that will not even parse as JSON is treated the same way — as
 *     a document whose fields all fell back, not as a fatal error.
 *  3. "Settings writes should be debounced or deduplicated." Both, here: a run of changes
 *     collapses into one write, and a write whose content matches what is already on disk is
 *     skipped entirely.
 *
 * The renderer holds the live values and sends *patches*; main keeps the authoritative persisted
 * copy and merges. That split is deliberate. The alternative — the renderer assembling and
 * sending the whole `Settings` object — means every slice that owns one group has to be able to
 * read the others, which `combineSlices` specifically does not allow.
 */

export interface SettingsStore {
  /** The current persisted settings. Available synchronously once `load` has resolved. */
  current(): Settings;
  /** Which fields the file had but could not be used. Reported to the user once, at startup. */
  invalidFields(): readonly string[];
  /** Reads the file. Called once during bootstrap; safe to call again. */
  load(): Promise<ParsedSettings>;
  /** Merges a patch into the current settings and schedules a write. */
  merge(patch: SettingsPatch): void;
  /**
   * Writes a pending change immediately and synchronously. Called from `before-quit`.
   *
   * Synchronous for the reason recorded in main/index.ts: an Electron quit handler cannot await,
   * and preventing the quit to finish an async write is the dance that does not work — Electron
   * does not restart a cancelled quit sequence. A settings document is a few hundred bytes, so
   * the blocking write costs less than the `preventDefault` would.
   */
  flushSync(): void;
  dispose(): void;
}

/**
 * A patch names whole groups, because a group is what a settings UI section edits.
 *
 * `| undefined` is explicit because the project compiles with `exactOptionalPropertyTypes`, and
 * the zod-inferred request type spells its optional members that way.
 */
export type SettingsPatch = {
  readonly [K in keyof Settings]?: Settings[K] | undefined;
};

export interface SettingsStoreOptions {
  /** Absolute path to the settings file. */
  readonly file: string;
  /**
   * Debounce window. Long enough that dragging a font-size slider produces one write, short
   * enough that a setting changed and then a crash a second later is not lost.
   */
  readonly debounceMs?: number;
  readonly io?: SettingsIo;
  readonly setTimer?: (callback: () => void, ms: number) => NodeJS.Timeout;
  readonly clearTimer?: (handle: NodeJS.Timeout) => void;
  /** Reported rather than thrown: a settings file that cannot be written must not stop the app. */
  readonly onError?: (detail: string) => void;
}

/** The filesystem, injected so the store is testable without touching a disk. */
export interface SettingsIo {
  read(file: string): Promise<string>;
  /** Must be atomic from a reader's point of view — see the note on `writeAtomic`. */
  write(file: string, contents: string): Promise<void>;
  /** The same write, for the one caller that cannot await: `before-quit`. */
  writeSync(file: string, contents: string): void;
}

/**
 * Write to a sibling temp file and rename over the target.
 *
 * `rename` within a directory is atomic on every platform Azir targets, so a reader — a future
 * launch, or a person with the file open — sees either the whole old document or the whole new
 * one. A plain `writeFile` truncates first, and a crash in the window between truncate and write
 * leaves an empty settings file. That is a real way to lose a user's configuration to an
 * unrelated bug.
 */
const writeAtomic = async (file: string, contents: string): Promise<void> => {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, contents, 'utf8');
  await rename(temporary, file);
};

const writeAtomicSync = (file: string, contents: string): void => {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, contents, 'utf8');
  renameSync(temporary, file);
};

export const defaultSettingsIo: SettingsIo = {
  read: (file) => readFile(file, 'utf8'),
  write: writeAtomic,
  writeSync: writeAtomicSync,
};

const DEFAULT_DEBOUNCE_MS = 400;

export const createSettingsStore = (options: SettingsStoreOptions): SettingsStore => {
  const io = options.io ?? defaultSettingsIo;
  const setTimer = options.setTimer ?? setTimeout;
  const clearTimer = options.clearTimer ?? clearTimeout;
  const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;

  let settings: Settings = defaultSettings;
  let invalid: readonly string[] = [];
  /**
   * What is believed to be on disk, serialised. The deduplication half of the requirement: a
   * patch that changes nothing — clicking the arrangement that is already selected, or a
   * renderer that re-sends its state — produces no write at all.
   */
  let persisted: string | null = null;
  let timer: NodeJS.Timeout | undefined;
  let writing: Promise<void> = Promise.resolve();

  const serialise = (value: Settings): string => `${JSON.stringify(value, null, 2)}\n`;

  const writeNow = async (): Promise<void> => {
    const contents = serialise(settings);
    if (contents === persisted) {
      return;
    }
    try {
      await io.write(options.file, contents);
      persisted = contents;
    } catch (error) {
      // Left un-persisted so a later change tries again, rather than recording a write that
      // did not happen and then deduplicating the retry away.
      options.onError?.(describeError(error));
    }
  };

  const schedule = (): void => {
    if (timer !== undefined) {
      clearTimer(timer);
    }
    timer = setTimer(() => {
      timer = undefined;
      writing = writing.then(writeNow);
    }, debounceMs);
  };

  return {
    current: () => settings,
    invalidFields: () => invalid,

    async load() {
      let raw: unknown;
      try {
        const text = await io.read(options.file);
        raw = JSON.parse(text);
        // The file as read is what is on disk, but it is not what `serialise` would produce for
        // the same settings (key order, whitespace, fields that fell back). Leaving `persisted`
        // null means the first write after a change is never deduplicated away against a
        // formatting difference.
      } catch (error) {
        // Two cases, deliberately handled the same way: no file yet (the common one, on first
        // launch) and a file that is not JSON. Neither is an error the user needs to see as a
        // failure — the second is reported through `invalidFields` instead.
        const missing = (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
        const parsed: ParsedSettings = missing
          ? { settings: defaultSettings, invalidFields: [] }
          : { settings: defaultSettings, invalidFields: ['<root>'] };
        settings = parsed.settings;
        invalid = parsed.invalidFields;
        return parsed;
      }

      const parsed = parseSettings(raw);
      settings = parsed.settings;
      invalid = parsed.invalidFields;
      return parsed;
    },

    merge(patch) {
      settings = {
        layout: patch.layout ?? settings.layout,
        terminal: patch.terminal ?? settings.terminal,
        editor: patch.editor ?? settings.editor,
        appearance: patch.appearance ?? settings.appearance,
      };
      schedule();
    },

    flushSync() {
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
      }
      const contents = serialise(settings);
      if (contents === persisted) {
        return;
      }
      try {
        io.writeSync(options.file, contents);
        persisted = contents;
      } catch (error) {
        options.onError?.(describeError(error));
      }
    },

    dispose() {
      if (timer !== undefined) {
        clearTimer(timer);
        timer = undefined;
      }
    },
  };
};
