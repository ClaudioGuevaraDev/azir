import { app, BrowserWindow } from 'electron';
import { createAppContext } from './app/context';
import { registerIpcHandlers } from './ipc/register';
import { createMainWindow } from './windows/mainWindow';
import { installGlobalWebContentsGuards } from './windows/security';

/**
 * Main-process entry point.
 *
 * Startup order matters and follows docs/architecture.md: guards and IPC
 * handlers are installed before any window exists, so a renderer can never
 * reach an unguarded WebContents or invoke an unregistered channel.
 */

const focusExistingWindow = (): void => {
  const [existing] = BrowserWindow.getAllWindows();
  if (!existing) {
    return;
  }
  if (existing.isMinimized()) {
    existing.restore();
  }
  existing.focus();
};

const bootstrap = async (): Promise<void> => {
  installGlobalWebContentsGuards();

  const context = createAppContext();

  app.on('second-instance', focusExistingWindow);

  app.on('window-all-closed', () => {
    // A workspace belongs to a window, so it goes when the window does — this is
    // also the path taken when the renderer dies unexpectedly.
    context.sessions.closeAll();

    // macOS convention keeps the app alive with no windows; every other
    // platform expects the process to end.
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });

  /**
   * Releases whatever the workspace owns — PTYs from M2, the watcher from M5 —
   * synchronously, and never prevents the quit.
   *
   * The tempting version of this handler awaits async cleanup inside `will-quit`
   * with `preventDefault`, then calls `app.quit()` again when it finishes. That
   * does not work: Electron does not restart a quit sequence, so the second
   * `app.quit()` is a no-op and the process stays alive with zero windows.
   * Measured directly, not inferred. Hence synchronous disposal — see
   * SessionDisposeListener in workspace/sessions.ts.
   */
  app.on('before-quit', () => {
    context.sessions.closeAll();
    // Belt and braces: `closeAll` releases what the live session owned, and these
    // catch anything left over. An orphan shell in Task Manager is the failure mode,
    // and it is invisible until the user goes looking.
    context.terminals.disposeAll();
    context.watcher.stopAll();
  });

  await app.whenReady();

  registerIpcHandlers(context);

  const window = createMainWindow();
  // Bound to this window's WebContents rather than broadcast, so a service can
  // never push to a window it does not belong to.
  context.renderer.attach(window.webContents);
};

// Two copies of Azir supervising the same workspace would each own a watcher
// and a set of PTYs with no knowledge of the other.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void bootstrap();
}
