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
  background: cssValue('--azir-bg', '#050506'),
  foreground: cssValue('--azir-text', '#f4f4f2'),
  cursor: cssValue('--azir-cursor', '#f4f4f2'),
  selectionBackground: cssValue('--azir-selection', '#303036'),
  black: cssValue('--azir-ansi-black', '#050506'),
  red: cssValue('--azir-ansi-red', '#f0786d'),
  green: cssValue('--azir-ansi-green', '#78dba2'),
  yellow: cssValue('--azir-ansi-yellow', '#efbc61'),
  blue: cssValue('--azir-ansi-blue', '#76b8d6'),
  magenta: cssValue('--azir-ansi-magenta', '#d995c7'),
  cyan: cssValue('--azir-ansi-cyan', '#78cfc4'),
  white: cssValue('--azir-ansi-white', '#e4ece5'),
  brightBlack: cssValue('--azir-ansi-bright-black', '#7f998f'),
  brightRed: cssValue('--azir-ansi-bright-red', '#ff8a7f'),
  brightGreen: cssValue('--azir-ansi-bright-green', '#7ce09f'),
  brightYellow: cssValue('--azir-ansi-bright-yellow', '#f2cc6b'),
  brightBlue: cssValue('--azir-ansi-bright-blue', '#85bdff'),
  brightMagenta: cssValue('--azir-ansi-bright-magenta', '#eaa6f5'),
  brightCyan: cssValue('--azir-ansi-bright-cyan', '#a2e3dc'),
  brightWhite: cssValue('--azir-ansi-bright-white', '#f2f6fb'),
});

export const readTerminalFontFamily = (): string =>
  cssValue('--azir-font-mono', 'Consolas, monospace');
