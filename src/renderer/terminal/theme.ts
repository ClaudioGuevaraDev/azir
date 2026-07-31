import type { TerminalThemeColors } from './controller';

/**
 * Reads the terminal palette out of the CSS custom properties in ui/tokens.css.
 *
 * xterm.js paints to a canvas, so it cannot inherit CSS — it needs literal colour
 * values. Reading them from the same tokens the rest of the UI uses is what keeps
 * the terminal from looking like a foreign element pasted into the window, and it
 * means a future light theme changes one file rather than two.
 */

const cssValue = (name: string, fallback: string): string => {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value === '' ? fallback : value;
};

export const readTerminalTheme = (): TerminalThemeColors => ({
  background: cssValue('--azir-bg', '#0b0d10'),
  foreground: cssValue('--azir-text', '#d6dde6'),
  cursor: cssValue('--azir-cursor', '#4d9dff'),
  selectionBackground: cssValue('--azir-selection', '#2b3d54'),
  black: cssValue('--azir-ansi-black', '#0b0d10'),
  red: cssValue('--azir-ansi-red', '#f2685c'),
  green: cssValue('--azir-ansi-green', '#4ec97a'),
  yellow: cssValue('--azir-ansi-yellow', '#e0b341'),
  blue: cssValue('--azir-ansi-blue', '#4d9dff'),
  magenta: cssValue('--azir-ansi-magenta', '#d778e8'),
  cyan: cssValue('--azir-ansi-cyan', '#56b6c2'),
  white: cssValue('--azir-ansi-white', '#d6dde6'),
  brightBlack: cssValue('--azir-ansi-bright-black', '#5b6672'),
  brightRed: cssValue('--azir-ansi-bright-red', '#ff8579'),
  brightGreen: cssValue('--azir-ansi-bright-green', '#6fe098'),
  brightYellow: cssValue('--azir-ansi-bright-yellow', '#f5cc5f'),
  brightBlue: cssValue('--azir-ansi-bright-blue', '#79b6ff'),
  brightMagenta: cssValue('--azir-ansi-bright-magenta', '#e79bf5'),
  brightCyan: cssValue('--azir-ansi-bright-cyan', '#79d2dd'),
  brightWhite: cssValue('--azir-ansi-bright-white', '#f0f4f9'),
});

export const readTerminalFontFamily = (): string =>
  cssValue('--azir-font-mono', 'Consolas, monospace');
