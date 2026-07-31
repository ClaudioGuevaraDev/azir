import { describe, expect, it } from 'vitest';
import { defaultLayoutSettings } from './layout';
import {
  defaultSettings,
  lineHeightFor,
  parseSettings,
  SHELL_KINDS,
  type Settings,
} from './settings';

/**
 * docs/architecture.md, Settings: "Malformed configuration falls back per field rather than
 * discarding the entire file."
 *
 * That sentence is the whole subject of this file. The failure it rules out is the easy one to
 * write by accident: `schema.safeParse(json)` on the whole document, one bad key, and every other
 * setting the user configured is silently reset.
 */

describe('parseSettings', () => {
  it('returns the defaults for an absent file', () => {
    const parsed = parseSettings(undefined);

    expect(parsed.settings).toEqual(defaultSettings);
    // Absent is not invalid. A first launch must not report that anything was wrong.
    expect(parsed.invalidFields).toEqual([]);
  });

  it('reads a complete, valid document', () => {
    const written: Settings = {
      layout: { order: ['terminal', 'viewer', 'repository'], arrangement: 'columns' },
      terminal: { shell: 'cmd' },
      editor: { tabWidth: 4 },
      appearance: { codeFontSize: 16 },
    };

    const parsed = parseSettings(JSON.parse(JSON.stringify(written)));

    expect(parsed.settings).toEqual(written);
    expect(parsed.invalidFields).toEqual([]);
  });

  it('keeps the valid fields when one field is malformed', () => {
    const parsed = parseSettings({
      layout: { order: ['terminal', 'viewer', 'repository'], arrangement: 'diagonal' },
      editor: { tabWidth: 4 },
    });

    // The arrangement is the only thing that fell back. The order and the tab width beside it
    // survive, which is the entire requirement.
    expect(parsed.settings.layout.arrangement).toBe(defaultLayoutSettings.arrangement);
    expect(parsed.settings.layout.order).toEqual(['terminal', 'viewer', 'repository']);
    expect(parsed.settings.editor.tabWidth).toBe(4);
    expect(parsed.invalidFields).toEqual(['layout.arrangement']);
  });

  it('reports every malformed field rather than stopping at the first', () => {
    const parsed = parseSettings({
      terminal: { shell: 'fish' },
      editor: { tabWidth: 0 },
      appearance: { codeFontSize: 400 },
    });

    expect(parsed.invalidFields).toEqual([
      'terminal.shell',
      'editor.tabWidth',
      'appearance.codeFontSize',
    ]);
    expect(parsed.settings).toEqual(defaultSettings);
  });

  it('falls back for a group that is not an object at all', () => {
    const parsed = parseSettings({ editor: 'four', appearance: { codeFontSize: 14 } });

    expect(parsed.invalidFields).toEqual(['editor']);
    expect(parsed.settings.editor).toEqual(defaultSettings.editor);
    // And the group beside it is still read.
    expect(parsed.settings.appearance.codeFontSize).toBe(14);
  });

  it('treats a document that is not an object as one invalid field', () => {
    for (const raw of [[], 'nonsense', 42, null]) {
      const parsed = parseSettings(raw);
      expect(parsed.settings).toEqual(defaultSettings);
      expect(parsed.invalidFields).toEqual(['<root>']);
    }
  });

  it('rejects a panel order that is not a permutation', () => {
    /*
     * `['viewer', 'viewer', 'terminal']` satisfies `[Panel, Panel, Panel]` and would delete the
     * repository panel from the application — no error, no file browser. A hand-edited settings
     * file is exactly where this comes from.
     */
    const parsed = parseSettings({ layout: { order: ['viewer', 'viewer', 'terminal'] } });

    expect(parsed.invalidFields).toEqual(['layout.order']);
    expect(parsed.settings.layout.order).toEqual(defaultLayoutSettings.order);
  });

  it.each([
    ['too short', ['viewer', 'terminal']],
    ['too long', ['viewer', 'terminal', 'repository', 'viewer']],
    ['an unknown panel', ['viewer', 'terminal', 'debugger']],
    ['not an array', { 0: 'viewer' }],
  ])('rejects a panel order that is %s', (_label, order) => {
    expect(parseSettings({ layout: { order } }).invalidFields).toEqual(['layout.order']);
  });

  it('rejects a non-integer tab width', () => {
    // 2.5 spaces is not a thing, and `Array(2.5).join(' ')` would quietly produce two.
    expect(parseSettings({ editor: { tabWidth: 2.5 } }).invalidFields).toEqual(['editor.tabWidth']);
  });

  it('accepts every shell the settings UI can offer', () => {
    for (const shell of SHELL_KINDS) {
      const parsed = parseSettings({ terminal: { shell } });
      expect(parsed.invalidFields).toEqual([]);
      expect(parsed.settings.terminal.shell).toBe(shell);
    }
  });

  it('survives a round trip through JSON', () => {
    const parsed = parseSettings(JSON.parse(JSON.stringify(defaultSettings)));
    expect(parsed).toEqual({ settings: defaultSettings, invalidFields: [] });
  });
});

describe('lineHeightFor', () => {
  it('returns whole pixels', () => {
    // The virtualiser multiplies this by a row index to position rows absolutely; a fractional
    // height accumulates rounding error down the file until the gutter no longer lines up.
    for (let size = 10; size <= 22; size += 1) {
      expect(Number.isInteger(lineHeightFor(size))).toBe(true);
    }
  });

  it('grows with the font size', () => {
    expect(lineHeightFor(10)).toBeLessThan(lineHeightFor(16));
  });
});
