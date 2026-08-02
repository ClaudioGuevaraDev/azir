import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { WINDOW_BACKGROUND } from '@shared/constants/appearance';

/**
 * Two facts about the palette that no type can hold, because one side of each is a stylesheet.
 *
 * The first is the window background. Electron paints it before the renderer has produced a frame,
 * so main has to know the colour as a literal — and a palette change that updates tokens.css and
 * forgets `WINDOW_BACKGROUND` produces a flash of the old dark on every launch, which is exactly
 * the kind of defect nobody files.
 *
 * The second is contrast. `--azir-text-dim` is the colour of the status bar, both gutters and every
 * path in the window, all of it set at 11px; it was previously 4.0:1 against the background, under
 * WCAG AA for text that size. The ratio is not a preference anyone can eyeball later, so it is
 * asserted here rather than written down in a comment and trusted.
 */

const tokensPath = path.resolve(__dirname, '..', 'src', 'renderer', 'ui', 'tokens.css');
const tokens = readFileSync(tokensPath, 'utf8');

const token = (name: string): string => {
  const match = new RegExp(`^\\s*--${name}:\\s*([^;]+);`, 'm').exec(tokens);
  if (!match?.[1]) {
    throw new Error(`tokens.css has no --${name}`);
  }
  return match[1].trim();
};

/** WCAG 2.x relative luminance. Only `#rrggbb` appears in tokens.css, so only that is parsed. */
const luminance = (hex: string): number => {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!match) {
    throw new Error(`not a six-digit hex colour: ${hex}`);
  }
  const [r, g, b] = [match[1], match[2], match[3]].map((pair) => {
    const channel = Number.parseInt(pair as string, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (foreground: string, background: string): number => {
  const [light, dark] = [luminance(foreground), luminance(background)].sort((a, b) => b - a) as [
    number,
    number,
  ];
  return (light + 0.05) / (dark + 0.05);
};

describe('design tokens', () => {
  it('keeps the window background in step with --azir-bg', () => {
    expect(token('azir-bg')).toBe(WINDOW_BACKGROUND);
  });

  /*
   * Both backgrounds, because these four are read on either. `--azir-surface` is the lighter of the
   * two and therefore the harder case for light text, so passing on both is what makes the numbers
   * hold wherever the text lands.
   */
  it.each(['azir-text', 'azir-text-muted', 'azir-text-dim'])(
    '--%s clears WCAG AA on both surfaces',
    (name) => {
      expect(contrast(token(name), token('azir-bg'))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(token(name), token('azir-surface'))).toBeGreaterThanOrEqual(4.5);
    },
  );

  /*
   * The accent is link text in the git-retry and diff-conflict rows, both at 11px, so it is held to
   * the same floor rather than treated as decoration.
   */
  it('keeps the accent readable as text', () => {
    expect(contrast(token('azir-accent'), token('azir-bg'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(token('azir-accent'), token('azir-surface'))).toBeGreaterThanOrEqual(4.5);
  });

  /*
   * The README reserves colour for "the thing that carries information — what changed", which only
   * works if the chrome is not wearing one of those hues. Accent and renamed were the same hex
   * before this palette; that is the regression being pinned.
   */
  it('does not spend a git hue on the chrome accent', () => {
    const git = [
      'azir-added',
      'azir-modified',
      'azir-deleted',
      'azir-renamed',
      'azir-conflict',
    ].map(token);
    expect(git).not.toContain(token('azir-accent'));
    expect(git).not.toContain(token('azir-brass'));
  });
});
