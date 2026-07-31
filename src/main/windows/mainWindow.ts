import { join } from 'node:path';
import { BrowserWindow } from 'electron';
import { applyWindowSecurity } from './security';

/**
 * The three mandatory security settings, hoisted out of the constructor call so
 * a test can assert them without launching Electron. docs/architecture.md lists
 * them as required, not recommended.
 */
export const SECURE_WEB_PREFERENCES = {
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  allowRunningInsecureContent: false,
  experimentalFeatures: false,
  spellcheck: false,
} as const;

/** Matches --background-color and tokens.css so startup has no white flash. */
const BACKGROUND = '#0b0d10';

export const createMainWindow = (): BrowserWindow => {
  const window = new BrowserWindow({
    width: 1440,
    height: 900,
    // Small enough that the layout engine's single-panel fallback is actually reachable
    // rather than theoretical. The spec requires a reduced window to degrade usefully, and a
    // floor that keeps three panels visible would make that promise untestable.
    minWidth: 400,
    minHeight: 280,
    // Shown on 'ready-to-show' instead. The spec requires the window to become
    // visible before expensive workspace work finishes, and an unpainted window
    // is worse than a slightly later one.
    show: false,
    backgroundColor: BACKGROUND,
    autoHideMenuBar: true,
    ...(process.platform === 'darwin' ? { titleBarStyle: 'hiddenInset' as const } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      ...SECURE_WEB_PREFERENCES,
    },
  });

  applyWindowSecurity(window);

  window.once('ready-to-show', () => {
    window.show();
  });

  // electron-vite injects this in dev and leaves it unset in a packaged build.
  const rendererUrl = process.env.ELECTRON_RENDERER_URL;
  if (rendererUrl !== undefined && rendererUrl !== '') {
    void window.loadURL(rendererUrl);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return window;
};
