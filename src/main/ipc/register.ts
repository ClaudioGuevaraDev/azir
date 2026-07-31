import { CHANNELS } from '@shared/ipc/channels';
import {
  createTerminalRequestSchema,
  gitDiffRequestSchema,
  gitStatusRequestSchema,
  killTerminalRequestSchema,
  listDirectoryRequestSchema,
  noRequestSchema,
  pingRequestSchema,
  readFileRequestSchema,
  resizeTerminalRequestSchema,
  saveSettingsRequestSchema,
  unsavedRequestSchema,
  workspaceCloseRequestSchema,
  workspaceOpenRequestSchema,
  writeFileRequestSchema,
  writeTerminalRequestSchema,
  type CreateTerminalResponse,
  type ListDirectoryResponse,
  type PickFolderResponse,
  type PingResponse,
  type ReadFileResponse,
  type SettingsSnapshot,
  type WorkspaceCloseResponse,
  type WriteFileResponse,
} from '@shared/ipc/contracts';
import { err, ok, type Result } from '@shared/ipc/result';
import { ipcMain } from 'electron';
import type { AppContext } from '../app/context';
import { handle, handleResult, listen } from './handle';

/**
 * Install every IPC handler. Called once, before the first window is created, so
 * no renderer can ever invoke a channel that is not yet registered.
 *
 * Handlers are thin: they validate (via `handle`), delegate to a service on the
 * context, and return. Anything with behaviour worth testing lives in the service.
 */
export const registerIpcHandlers = (context: AppContext): void => {
  handle(CHANNELS.appPing, pingRequestSchema, (request): PingResponse => {
    return {
      nonce: request.nonce,
      electron: process.versions.electron ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
      node: process.versions.node,
      platform: process.platform,
    };
  });

  // ---- workspace

  handle(CHANNELS.workspacePickFolder, noRequestSchema, (): Promise<PickFolderResponse> =>
    context.dialogs.pickDirectory(),
  );

  // handleResult, not handle: "that folder does not exist" is an ordinary outcome
  // the reducer should render, not an exception.
  handleResult(CHANNELS.workspaceOpen, workspaceOpenRequestSchema, async (request) => {
    const opened = await context.sessions.open(request.path);
    if (opened.ok) {
      // Started here rather than on a separate channel so a workspace is never live
      // without a watcher — the gap would be a window in which an agent's changes go
      // unnoticed. A watcher that fails to start reports and leaves manual refresh
      // working.
      context.watcher.start(opened.value.sessionId, opened.value.root);
    }
    return opened;
  });

  handle(
    CHANNELS.workspaceClose,
    workspaceCloseRequestSchema,
    (request): WorkspaceCloseResponse => ({
      closed: context.sessions.close(request.sessionId),
    }),
  );

  // ---- files

  handleResult(
    CHANNELS.filesListDirectory,
    listDirectoryRequestSchema,
    async (request): Promise<Result<ListDirectoryResponse>> => {
      // `resolve` is the session gate and the path sandbox in one call, and it
      // checks the session first so a dead workspace leaks no information about
      // whether a path exists.
      const absolute = context.sessions.resolve(request.sessionId, request.path);
      if (!absolute.ok) {
        return err(absolute.error.code, absolute.error.message);
      }

      const entries = await context.files.listDirectory(absolute.value, request.path);
      if (!entries.ok) {
        return err(entries.error.code, entries.error.message, entries.error.detail);
      }

      return ok({ path: request.path, entries: entries.value });
    },
  );

  handleResult(
    CHANNELS.filesRead,
    readFileRequestSchema,
    async (request): Promise<Result<ReadFileResponse>> => {
      const absolute = context.sessions.resolve(request.sessionId, request.path);
      if (!absolute.ok) {
        return err(absolute.error.code, absolute.error.message);
      }
      return context.files.readFile(absolute.value, request.path);
    },
  );

  handleResult(
    CHANNELS.filesWrite,
    writeFileRequestSchema,
    async (request): Promise<Result<WriteFileResponse>> => {
      const absolute = context.sessions.resolve(request.sessionId, request.path);
      if (!absolute.ok) {
        return err(absolute.error.code, absolute.error.message);
      }
      return context.files.writeFile(absolute.value, request.path, {
        content: request.content,
        eol: request.eol,
        hadBom: request.hadBom,
      });
    },
  );

  // ---- git

  handleResult(CHANNELS.gitDiff, gitDiffRequestSchema, async (request) => {
    const session = context.sessions.require(request.sessionId);
    if (!session.ok) {
      return err(session.error.code, session.error.message);
    }
    // Resolved even though git receives the relative path, so a traversal is refused
    // before a pathspec ever reaches the process.
    const inside = context.sessions.resolve(request.sessionId, request.path);
    if (!inside.ok) {
      return err(inside.error.code, inside.error.message);
    }
    return context.git.diff(session.value.root, request.path, request.target ?? 'worktree');
  });

  handleResult(CHANNELS.gitStatus, gitStatusRequestSchema, (request) => {
    const session = context.sessions.require(request.sessionId);
    if (!session.ok) {
      return err(session.error.code, session.error.message);
    }
    // The root comes from the session, so git can never be pointed at a directory
    // outside the workspace.
    return context.git.status(session.value.root);
  });

  // ---- settings

  // `handle`, not `handleResult`: main loaded the file during bootstrap and already turned every
  // failure into a per-field fallback, so by the time a renderer can ask there is nothing left to
  // fail. What *is* reported is which fields fell back.
  handle(CHANNELS.settingsLoad, noRequestSchema, (): SettingsSnapshot => {
    return {
      settings: context.settings.current(),
      invalidFields: context.settings.invalidFields(),
    };
  });

  listen(CHANNELS.settingsSave, saveSettingsRequestSchema, (request) => {
    context.settings.merge(request);
  });

  // ---- terminal

  handleResult(
    CHANNELS.terminalCreate,
    createTerminalRequestSchema,
    (request): Result<CreateTerminalResponse> => {
      // The session gate comes first, and both the cwd and the shell come from main's own
      // records — never from the renderer. A shell is the most powerful thing this application
      // can start, so neither where it runs nor which executable it is may be chosen by the
      // untrusted side.
      const session = context.sessions.require(request.sessionId);
      if (!session.ok) {
        return err(session.error.code, session.error.message);
      }

      return context.terminals.create({
        sessionId: request.sessionId,
        paneId: request.paneId,
        cwd: session.value.root,
        shell: context.settings.current().terminal.shell,
      });
    },
  );

  // `listen`, not `handle`: keystrokes and resizes are fire-and-forget. Awaiting a
  // reply per keypress would add a round trip to every character typed.
  listen(CHANNELS.terminalWrite, writeTerminalRequestSchema, (request) => {
    context.terminals.write(request.sessionId, request.paneId, request.data);
  });

  listen(CHANNELS.terminalResize, resizeTerminalRequestSchema, (request) => {
    context.terminals.resize(request.sessionId, request.paneId, request.cols, request.rows);
  });

  listen(CHANNELS.terminalKill, killTerminalRequestSchema, (request) => {
    context.terminals.kill(request.sessionId, request.paneId);
  });

  // ---- quit guard
  //
  // Pushed rather than asked for: `before-quit` cannot await, and preventing the quit to go
  // and fetch an answer is the dance that does not work. See app/quitGuard.ts.
  listen(CHANNELS.appSetUnsaved, unsavedRequestSchema, (request) => {
    context.quitGuard.setUnsaved(request.unsaved);
  });

  listen(CHANNELS.appConfirmQuit, noRequestSchema, () => {
    context.quitGuard.confirm();
  });
};

/** Removes every handler. Used when tearing down between tests. */
export const removeIpcHandlers = (): void => {
  for (const channel of Object.values(CHANNELS)) {
    ipcMain.removeHandler(channel);
    ipcMain.removeAllListeners(channel);
  }
};
