import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * docs/architecture.md lists the Electron security settings as mandatory
 * (invariant 14). They are the kind of thing that gets loosened while debugging
 * and silently stays loose, so they are asserted rather than trusted.
 */

interface CapturedOptions {
  webPreferences?: Record<string, unknown>;
  show?: boolean;
  backgroundColor?: string;
}

const constructed: CapturedOptions[] = [];
const loadURL = vi.fn();
const loadFile = vi.fn();

vi.mock('electron', () => {
  class FakeBrowserWindow {
    public readonly webContents = {
      setWindowOpenHandler: vi.fn(),
      on: vi.fn(),
      getURL: vi.fn(() => ''),
      session: { setPermissionRequestHandler: vi.fn() },
    };

    public readonly once = vi.fn();
    public readonly show = vi.fn();
    public readonly loadURL = loadURL;
    public readonly loadFile = loadFile;

    constructor(options: CapturedOptions) {
      constructed.push(options);
    }
  }

  return {
    BrowserWindow: FakeBrowserWindow,
    app: { on: vi.fn() },
    shell: { openExternal: vi.fn() },
  };
});

const { createMainWindow, SECURE_WEB_PREFERENCES } = await import('./mainWindow');

const originalRendererUrl = process.env.ELECTRON_RENDERER_URL;

beforeEach(() => {
  constructed.length = 0;
  loadURL.mockClear();
  loadFile.mockClear();
  delete process.env.ELECTRON_RENDERER_URL;
});

afterEach(() => {
  if (originalRendererUrl === undefined) {
    delete process.env.ELECTRON_RENDERER_URL;
  } else {
    process.env.ELECTRON_RENDERER_URL = originalRendererUrl;
  }
});

describe('SECURE_WEB_PREFERENCES', () => {
  it('keeps the renderer isolated from Node', () => {
    expect(SECURE_WEB_PREFERENCES.contextIsolation).toBe(true);
    expect(SECURE_WEB_PREFERENCES.nodeIntegration).toBe(false);
    expect(SECURE_WEB_PREFERENCES.sandbox).toBe(true);
    expect(SECURE_WEB_PREFERENCES.webSecurity).toBe(true);
    expect(SECURE_WEB_PREFERENCES.allowRunningInsecureContent).toBe(false);
  });
});

describe('createMainWindow', () => {
  it('applies the secure preferences and a preload script', () => {
    createMainWindow();

    const options = constructed[0];
    expect(options).toBeDefined();
    expect(options?.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    });
    expect(options?.webPreferences?.['preload']).toEqual(expect.stringContaining('preload'));
  });

  it('starts hidden with the app background colour, so the first paint has no white flash', () => {
    createMainWindow();

    expect(constructed[0]?.show).toBe(false);
    expect(constructed[0]?.backgroundColor).toBe('#0b0d10');
  });

  it('loads the packaged bundle from disk when no dev server is present', () => {
    createMainWindow();

    expect(loadFile).toHaveBeenCalledTimes(1);
    expect(loadURL).not.toHaveBeenCalled();
  });

  it('loads the dev server URL when electron-vite provides one', () => {
    process.env.ELECTRON_RENDERER_URL = 'http://localhost:5173';

    createMainWindow();

    expect(loadURL).toHaveBeenCalledWith('http://localhost:5173');
    expect(loadFile).not.toHaveBeenCalled();
  });

  it('treats an empty ELECTRON_RENDERER_URL as absent', () => {
    process.env.ELECTRON_RENDERER_URL = '';

    createMainWindow();

    expect(loadFile).toHaveBeenCalledTimes(1);
  });
});
