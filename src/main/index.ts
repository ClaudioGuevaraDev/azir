import { app, BrowserWindow } from 'electron';
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

  app.on('second-instance', focusExistingWindow);

  app.on('window-all-closed', () => {
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

  await app.whenReady();

  registerIpcHandlers();
  createMainWindow();
};

// Two copies of Azir supervising the same workspace would each own a watcher
// and a set of PTYs with no knowledge of the other.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  void bootstrap();
}
