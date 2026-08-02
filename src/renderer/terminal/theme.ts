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
  background: cssValue('--azir-bg', '#0a0d12'),
  foreground: cssValue('--azir-text', '#dde4ee'),
  cursor: cssValue('--azir-cursor', '#35c9e8'),
  selectionBackground: cssValue('--azir-selection', '#1c3742'),
  black: cssValue('--azir-ansi-black', '#0a0d12'),
  red: cssValue('--azir-ansi-red', '#f4695d'),
  green: cssValue('--azir-ansi-green', '#56cd80'),
  yellow: cssValue('--azir-ansi-yellow', '#e2b447'),
  blue: cssValue('--azir-ansi-blue', '#5aa4ff'),
  magenta: cssValue('--azir-ansi-magenta', '#d980ea'),
  cyan: cssValue('--azir-ansi-cyan', '#35c9e8'),
  white: cssValue('--azir-ansi-white', '#dde4ee'),
  brightBlack: cssValue('--azir-ansi-bright-black', '#7c8798'),
  brightRed: cssValue('--azir-ansi-bright-red', '#ff8a7f'),
  brightGreen: cssValue('--azir-ansi-bright-green', '#7ce09f'),
  brightYellow: cssValue('--azir-ansi-bright-yellow', '#f2cc6b'),
  brightBlue: cssValue('--azir-ansi-bright-blue', '#85bdff'),
  brightMagenta: cssValue('--azir-ansi-bright-magenta', '#eaa6f5'),
  brightCyan: cssValue('--azir-ansi-bright-cyan', '#74dcf2'),
  brightWhite: cssValue('--azir-ansi-bright-white', '#f2f6fb'),
});

export const readTerminalFontFamily = (): string =>
  cssValue('--azir-font-mono', 'Consolas, monospace');
