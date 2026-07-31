import { app, shell, type BrowserWindow, type WebContents } from 'electron';

/**
 * docs/architecture.md treats Electron security as an architectural concern,
 * not a hardening step applied at the end. These are the runtime halves of that
 * — the declarative half lives in `webPreferences` in mainWindow.ts.
 */

/** Protocols we are willing to hand to the user's default application. */
const ALLOWED_EXTERNAL_PROTOCOLS = new Set(['https:', 'http:', 'mailto:']);

/**
 * The renderer is a local bundle with no links of its own to follow, so the
 * only legitimate navigations are the initial load and a reload of the same
 * URL. Anything else is either a bug or injected content.
 */
const isSameDocument = (target: string, current: string): boolean => {
  if (current === '') {
    return false;
  }
  try {
    const a = new URL(target);
    const b = new URL(current);
    a.hash = '';
    b.hash = '';
    return a.href === b.href;
  } catch {
    return false;
  }
};

/**
 * Open a URL externally, but only after checking the protocol. Passing an
 * unvalidated string to `shell.openExternal` lets content pick the handler
 * program — `file:`, `smb:` and custom schemes all resolve to something on a
 * real machine.
 */
export const openExternalIfSafe = (rawUrl: string): void => {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return;
  }

  if (!ALLOWED_EXTERNAL_PROTOCOLS.has(parsed.protocol)) {
    console.warn(`[security] refused to open external url with protocol ${parsed.protocol}`);
    return;
  }

  void shell.openExternal(parsed.toString());
};

const guardWebContents = (contents: WebContents): void => {
  // Azir has exactly one window. A request for another is never expected, so
  // deny it and treat an http(s) target as "the user clicked a link".
  contents.setWindowOpenHandler(({ url }) => {
    openExternalIfSafe(url);
    return { action: 'deny' };
  });

  contents.on('will-navigate', (event, url) => {
    if (!isSameDocument(url, contents.getURL())) {
      event.preventDefault();
      openExternalIfSafe(url);
    }
  });

  // Nothing in this application embeds a webview.
  contents.on('will-attach-webview', (event) => {
    event.preventDefault();
  });

  // Deny every permission request outright. Azir needs none of them, and the
  // default for an unhandled request is to allow.
  contents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    console.warn(`[security] denied permission request: ${permission}`);
    callback(false);
  });
};

/**
 * Applies to any WebContents the app ever creates, including ones we did not
 * construct ourselves. Registered before the first window exists.
 */
export const installGlobalWebContentsGuards = (): void => {
  app.on('web-contents-created', (_event, contents) => {
    guardWebContents(contents);
  });
};

export const applyWindowSecurity = (window: BrowserWindow): void => {
  guardWebContents(window.webContents);
};
