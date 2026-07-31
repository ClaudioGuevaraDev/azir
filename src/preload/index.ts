import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { AppBridge, Unsubscribe } from '@shared/bridge';
import { CHANNELS } from '@shared/ipc/channels';

/**
 * The only code that both processes' worlds can see.
 *
 * This file must stay a thin, literal mapping from domain method to channel
 * constant. It deliberately contains no logic: anything with behaviour belongs in
 * the main process (where it can be tested against real system boundaries) or in
 * the renderer's effect runner (where it can be tested with a fake bridge). It
 * also cannot contain Node code — the window runs with `sandbox: true`, so the
 * preload has no filesystem or child_process access even though it is not the
 * renderer.
 */

/**
 * Subscribes to a main → renderer push and returns an unsubscribe.
 *
 * The `event` argument is dropped on purpose. It carries a `sender` that would
 * hand the renderer a live `WebContents`-shaped object across the bridge, which is
 * exactly the kind of capability leak `contextIsolation` exists to prevent.
 */
const subscribe = <T>(channel: string, listener: (payload: T) => void): Unsubscribe => {
  const handler = (_event: IpcRendererEvent, payload: T): void => {
    listener(payload);
  };
  ipcRenderer.on(channel, handler);
  return () => {
    ipcRenderer.removeListener(channel, handler);
  };
};

const bridge: AppBridge = {
  app: {
    ping: (request) => ipcRenderer.invoke(CHANNELS.appPing, request),
  },

  workspace: {
    pickFolder: () => ipcRenderer.invoke(CHANNELS.workspacePickFolder),
    open: (request) => ipcRenderer.invoke(CHANNELS.workspaceOpen, request),
    close: (request) => ipcRenderer.invoke(CHANNELS.workspaceClose, request),
  },

  files: {
    listDirectory: (request) => ipcRenderer.invoke(CHANNELS.filesListDirectory, request),
  },

  fs: {
    onChanged: (listener) => subscribe(CHANNELS.eventFsChanged, listener),
  },

  git: {
    status: (request) => ipcRenderer.invoke(CHANNELS.gitStatus, request),
  },

  terminal: {
    create: (request) => ipcRenderer.invoke(CHANNELS.terminalCreate, request),
    // `send`, not `invoke`: there is no reply to wait for, and a round trip per
    // keystroke is exactly what makes an embedded terminal feel laggy.
    write: (request) => {
      ipcRenderer.send(CHANNELS.terminalWrite, request);
    },
    resize: (request) => {
      ipcRenderer.send(CHANNELS.terminalResize, request);
    },
    kill: (request) => {
      ipcRenderer.send(CHANNELS.terminalKill, request);
    },
    onData: (listener) => subscribe(CHANNELS.eventTerminalData, listener),
    onExit: (listener) => subscribe(CHANNELS.eventTerminalExit, listener),
  },
};

contextBridge.exposeInMainWorld('azir', bridge);
