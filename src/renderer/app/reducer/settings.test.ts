import { describe, expect, it } from 'vitest';
import type { SettingsSnapshot } from '@shared/ipc/contracts';
import { defaultLayoutSettings } from '@shared/models/layout';
import { defaultSettings } from '@shared/models/settings';
import { dedupeEffects } from '../effects';
import { initialState } from '../state';
import { reduce } from './index';

/**
 * Settings, through the root reducer rather than the slice.
 *
 * Two of the three things worth asserting here are cross-slice: one `settings/loaded` action is
 * read by both the settings slice and the layout slice, and the save effect it must *not* produce
 * is a property of the whole reduction. A slice-level test could not see either.
 */

const snapshot = (overrides: Partial<SettingsSnapshot> = {}): SettingsSnapshot => ({
  settings: defaultSettings,
  invalidFields: [],
  ...overrides,
});

describe('loading', () => {
  it('asks main for the settings and does not write anything back', () => {
    const result = reduce(initialState, { type: 'settings/loadRequested' });

    expect(result.effects).toEqual([{ type: 'settings/load' }]);
    expect(result.state.settings.loaded).toBe(false);
  });

  it('applies the terminal, editor and appearance groups', () => {
    const result = reduce(initialState, {
      type: 'settings/loaded',
      snapshot: snapshot({
        settings: {
          layout: defaultLayoutSettings,
          terminal: { shell: 'bash' },
          editor: { tabWidth: 8 },
          appearance: { codeFontSize: 18 },
        },
      }),
    });

    expect(result.state.settings.terminal.shell).toBe('bash');
    expect(result.state.settings.editor.tabWidth).toBe(8);
    expect(result.state.settings.appearance.codeFontSize).toBe(18);
    expect(result.state.settings.loaded).toBe(true);
  });

  it('applies the layout group to the layout slice at the same time', () => {
    const result = reduce(initialState, {
      type: 'settings/loaded',
      snapshot: snapshot({
        settings: {
          ...defaultSettings,
          layout: { order: ['terminal', 'viewer', 'repository'], arrangement: 'columns' },
        },
      }),
    });

    // One action, two readers. Two actions could interleave with something else and leave the
    // window in a state that never existed in the file.
    expect(result.state.layout.settings.arrangement).toBe('columns');
    expect(result.state.layout.settings.order).toEqual(['terminal', 'viewer', 'repository']);
  });

  it('writes nothing back to disk when settings arrive', () => {
    /*
     * The loop this rules out: main sends the settings, the reducer treats them as a change, the
     * change emits a save, and every launch rewrites the file it just read. Harmless-looking, and
     * it means a settings file hand-edited to a value Azir does not understand is overwritten
     * with the fallback before the user can look at it.
     */
    const result = reduce(initialState, {
      type: 'settings/loaded',
      snapshot: snapshot({
        settings: { ...defaultSettings, editor: { tabWidth: 8 } },
      }),
    });

    expect(result.effects).toEqual([]);
  });

  it('carries the invalid fields through so the UI can name them', () => {
    const result = reduce(initialState, {
      type: 'settings/loaded',
      snapshot: snapshot({ invalidFields: ['editor.tabWidth'] }),
    });

    expect(result.state.settings.invalidFields).toEqual(['editor.tabWidth']);
  });
});

describe('changing a setting', () => {
  it('updates the live value and emits exactly one save', () => {
    const result = reduce(initialState, { type: 'settings/tabWidthChanged', tabWidth: 4 });

    expect(result.state.settings.editor.tabWidth).toBe(4);
    expect(result.effects).toEqual([{ type: 'settings/save', patch: { editor: { tabWidth: 4 } } }]);
  });

  it('sends only the group that changed', () => {
    const result = reduce(initialState, { type: 'settings/shellChanged', shell: 'cmd' });

    // A patch, not a document. Anything Azir does not model — a group written by a newer version
    // — survives the write instead of being erased by it.
    expect(result.effects).toEqual([
      { type: 'settings/save', patch: { terminal: { shell: 'cmd' } } },
    ]);
  });

  it('does nothing when the value is already set', () => {
    const once = reduce(initialState, { type: 'settings/codeFontSizeChanged', codeFontSize: 16 });

    const twice = reduce(once.state, {
      type: 'settings/codeFontSizeChanged',
      codeFontSize: 16,
    });

    // Identity, so nothing re-renders and no write is scheduled for a change that is not one.
    expect(twice.state).toBe(once.state);
    expect(twice.effects).toEqual([]);
  });

  it('persists a layout change from the layout slice', () => {
    const result = reduce(initialState, {
      type: 'layout/arrangementChanged',
      arrangement: 'rows',
    });

    expect(result.state.layout.settings.arrangement).toBe('rows');
    expect(result.effects).toEqual([
      {
        type: 'settings/save',
        patch: { layout: { ...defaultLayoutSettings, arrangement: 'rows' } },
      },
    ]);
  });

  it('does not persist a resize', () => {
    // Geometry is not a setting. Persisting it would write the file on every frame of a drag.
    const result = reduce(initialState, { type: 'layout/resized', width: 900, height: 600 });

    expect(result.effects).toEqual([]);
  });
});

describe('lifetime', () => {
  it('keeps the settings when the workspace closes', () => {
    const opened = reduce(initialState, { type: 'settings/tabWidthChanged', tabWidth: 8 });

    const closed = reduce(opened.state, { type: 'workspace/closed', sessionId: 1 });

    // Preferences about Azir, not about the folder.
    expect(closed.state.settings.editor.tabWidth).toBe(8);
  });

  it('leaves the arrangement alone when the workspace closes', () => {
    const changedLayout = reduce(initialState, {
      type: 'layout/arrangementChanged',
      arrangement: 'columns',
    });

    const closed = reduce(changedLayout.state, { type: 'workspace/closed', sessionId: 1 });

    expect(closed.state.layout.settings.arrangement).toBe('columns');
    // Only the measured size goes, because the panel area unmounts.
    expect(closed.state.layout.width).toBe(0);
  });
});

describe('effect deduplication', () => {
  it('collapses two identical saves', () => {
    const patch = { editor: { tabWidth: 4 } } as const;

    const deduped = dedupeEffects([
      { type: 'settings/save', patch },
      { type: 'settings/save', patch },
    ]);

    expect(deduped).toHaveLength(1);
  });

  it('keeps two saves of the same group with different values', () => {
    /*
     * The tempting key is the group name — "two writes to `editor` are the same work". It is
     * wrong, because `dedupeEffects` keeps the *first* occurrence: the earlier value would be
     * persisted and the one the user ended on discarded. Both are let through instead, and main's
     * debounce collapses them with the last one winning.
     */
    const deduped = dedupeEffects([
      { type: 'settings/save', patch: { editor: { tabWidth: 2 } } },
      { type: 'settings/save', patch: { editor: { tabWidth: 8 } } },
    ]);

    expect(deduped).toHaveLength(2);
  });

  it('keeps saves of different groups', () => {
    const deduped = dedupeEffects([
      { type: 'settings/save', patch: { editor: { tabWidth: 4 } } },
      { type: 'settings/save', patch: { terminal: { shell: 'cmd' } } },
    ]);

    expect(deduped).toHaveLength(2);
  });
});
