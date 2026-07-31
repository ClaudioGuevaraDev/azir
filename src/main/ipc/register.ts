import { CHANNELS } from '@shared/ipc/channels';
import { pingRequestSchema, type PingResponse } from '@shared/ipc/contracts';
import { handle } from './handle';

/**
 * Install every IPC handler. Called once, before the first window is created,
 * so no renderer can ever invoke a channel that is not yet registered.
 */
export const registerIpcHandlers = (): void => {
  handle(CHANNELS.appPing, pingRequestSchema, (request): PingResponse => {
    return {
      nonce: request.nonce,
      electron: process.versions.electron ?? 'unknown',
      chrome: process.versions.chrome ?? 'unknown',
      node: process.versions.node,
      platform: process.platform,
    };
  });
};
