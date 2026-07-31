import { CHANNELS } from '@shared/ipc/channels';
import {
  createTerminalRequestSchema,
  gitStatusRequestSchema,
  killTerminalRequestSchema,
  listDirectoryRequestSchema,
  noRequestSchema,
  pingRequestSchema,
  resizeTerminalRequestSchema,
  workspaceCloseRequestSchema,
  workspaceOpenRequestSchema,
  writeTerminalRequestSchema,
  type CreateTerminalResponse,
  type ListDirectoryResponse,
  type PickFolderResponse,
  type PingResponse,
  type WorkspaceCloseResponse,
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

  // ---- git

  handleResult(CHANNELS.gitStatus, gitStatusRequestSchema, (request) => {
    const session = context.sessions.require(request.sessionId);
    if (!session.ok) {
      return err(session.error.code, session.error.message);
    }
    // The root comes from the session, so git can never be pointed at a directory
    // outside the workspace.
    return context.git.status(session.value.root);
  });

  // ---- terminal

  handleResult(
    CHANNELS.terminalCreate,
    createTerminalRequestSchema,
    (request): Result<CreateTerminalResponse> => {
      // The session gate comes first, and the cwd comes from the root main
      // recorded — never from the renderer. A shell is the most powerful thing
      // this application can start, so it must not be startable outside the
      // workspace.
      const session = context.sessions.require(request.sessionId);
      if (!session.ok) {
        return err(session.error.code, session.error.message);
      }

      return context.terminals.create({
        sessionId: request.sessionId,
        paneId: request.paneId,
        cwd: session.value.root,
        shell: request.shell ?? 'default',
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
};

/** Removes every handler. Used when tearing down between tests. */
export const removeIpcHandlers = (): void => {
  for (const channel of Object.values(CHANNELS)) {
    ipcMain.removeHandler(channel);
    ipcMain.removeAllListeners(channel);
  }
};
