import { CHANNELS } from '@shared/ipc/channels';
import {
  noRequestSchema,
  pingRequestSchema,
  workspaceCloseRequestSchema,
  workspaceOpenRequestSchema,
  type PickFolderResponse,
  type PingResponse,
  type WorkspaceCloseResponse,
} from '@shared/ipc/contracts';
import type { AppContext } from '../app/context';
import { handle, handleResult } from './handle';

/**
 * Install every IPC handler. Called once, before the first window is created, so
 * no renderer can ever invoke a channel that is not yet registered.
 *
 * Handlers are thin: they validate (via `handle`), delegate to a service on the
 * context, and return. Anything with behaviour worth testing lives in the
 * service, not here.
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

  handle(CHANNELS.workspacePickFolder, noRequestSchema, (): Promise<PickFolderResponse> =>
    context.dialogs.pickDirectory(),
  );

  // handleResult, not handle: "that folder does not exist" is an ordinary
  // outcome the reducer should render, not an exception.
  handleResult(CHANNELS.workspaceOpen, workspaceOpenRequestSchema, (request) =>
    context.sessions.open(request.path),
  );

  handle(
    CHANNELS.workspaceClose,
    workspaceCloseRequestSchema,
    (request): WorkspaceCloseResponse => ({
      closed: context.sessions.close(request.sessionId),
    }),
  );
};
