import { contextBridge, ipcRenderer } from 'electron';
import type { AppBridge } from '@shared/bridge';
import { CHANNELS } from '@shared/ipc/channels';

/**
 * The only code that both processes' worlds can see.
 *
 * This file must stay a thin, literal mapping from domain method to channel
 * constant. It deliberately contains no logic: anything with behaviour belongs
 * in the main process (where it can be tested against real system boundaries)
 * or in the renderer's effect runner (where it can be tested with a fake
 * bridge). It also cannot contain Node code — the window runs with
 * `sandbox: true`, so the preload has no filesystem or child_process access even
 * though it is not the renderer.
 */
const bridge: AppBridge = {
  app: {
    ping: (request) => ipcRenderer.invoke(CHANNELS.appPing, request),
  },

  workspace: {
    pickFolder: () => ipcRenderer.invoke(CHANNELS.workspacePickFolder),
    open: (request) => ipcRenderer.invoke(CHANNELS.workspaceOpen, request),
    close: (request) => ipcRenderer.invoke(CHANNELS.workspaceClose, request),
  },
};

contextBridge.exposeInMainWorld('azir', bridge);
