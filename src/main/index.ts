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
  // Installed before the window exists, so a quit can never slip past it.
  context.quitGuard.install();

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
    // First, and the order is not cosmetic: `closeAll` reaches the terminal manager
    // through the session disposal listener, so anything that has to be true before a
    // pane is torn down has to be set before this line. What this switches on is
    // killing shells by pid rather than through node-pty, which otherwise forks a
    // child that inherits our stdio and outlives us — see `beginShutdown`.
    context.terminals.beginShutdown();
    context.sessions.closeAll();
    // Belt and braces: `closeAll` releases what the live session owned, and these
    // catch anything left over. An orphan shell in Task Manager is the failure mode,
    // and it is invisible until the user goes looking.
    context.terminals.disposeAll();
    context.watcher.stopAll();
    context.search.stopAll();
    // Synchronous for the same reason as everything above it. A setting changed inside the
    // debounce window and then quit is otherwise lost, which reads as the setting not working.
    context.settings.flushSync();
  });

  await app.whenReady();

  /*
   * Loaded before the window exists, so `settings:load` is a cached read rather than a disk
   * round trip on the renderer's critical path — docs/architecture.md: "Settings are loaded by
   * the main process at startup."
   *
   * Awaited rather than fired off: the alternative is a window that renders with the defaults
   * and then rearranges itself a moment later, which looks like a bug and moves the panel the
   * user was about to click.
   */
  await context.settings.load();

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
