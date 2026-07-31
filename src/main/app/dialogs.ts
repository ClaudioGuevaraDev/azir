import { BrowserWindow, dialog } from 'electron';

/**
 * Native dialogs, behind an interface so handlers can be tested without an
 * Electron instance. This is the only place `dialog` is touched.
 */
export interface DialogService {
  /** Resolves to the chosen absolute path, or null when cancelled. */
  pickDirectory(): Promise<string | null>;
}

export const createDialogService = (): DialogService => ({
  async pickDirectory() {
    // Parented to the focused window so the picker is modal to the app rather
    // than floating free, which on Windows can end up behind the main window.
    const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];

    const result = parent
      ? await dialog.showOpenDialog(parent, {
          title: 'Open workspace',
          properties: ['openDirectory', 'createDirectory'],
        })
      : await dialog.showOpenDialog({
          title: 'Open workspace',
          properties: ['openDirectory', 'createDirectory'],
        });

    if (result.canceled) {
      return null;
    }
    return result.filePaths[0] ?? null;
  },
});
