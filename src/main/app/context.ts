import { CHANNELS } from '@shared/ipc/channels';
import { createDialogService, type DialogService } from './dialogs';
import { createRendererChannel, type RendererChannel } from './rendererChannel';
import { createFileService, type FileService } from '../filesystem/fileService';
import { createTerminalManager, type TerminalManager } from '../terminal/terminalManager';
import { createSessionRegistry, type SessionRegistry } from '../workspace/sessions';

/**
 * The main process's services, assembled in one place and passed down.
 *
 * Deliberately not module-level singletons: docs/architecture.md's testing
 * strategy calls for main-process unit tests that mock the system boundaries, and
 * that is only possible if the thing under test receives its dependencies rather
 * than importing them.
 */
export interface AppContext {
  readonly sessions: SessionRegistry;
  readonly dialogs: DialogService;
  readonly files: FileService;
  readonly terminals: TerminalManager;
  readonly renderer: RendererChannel;
}

export type AppContextOverrides = Partial<AppContext>;

export const createAppContext = (overrides: AppContextOverrides = {}): AppContext => {
  const renderer = overrides.renderer ?? createRendererChannel();
  const sessions = overrides.sessions ?? createSessionRegistry();

  const terminals =
    overrides.terminals ??
    createTerminalManager({
      emitter: {
        data: (event) => {
          renderer.send(CHANNELS.eventTerminalData, event);
        },
        exit: (event) => {
          renderer.send(CHANNELS.eventTerminalExit, event);
        },
      },
    });

  // Closing a workspace kills the PTYs it owned; closing the app kills the rest
  // via `disposeAll` from `before-quit`. Wiring it here rather than inside the
  // registry keeps the registry ignorant of terminals — it only knows that
  // something wants to be told.
  sessions.onDispose((session) => {
    terminals.killSession(session.id);
  });

  return {
    sessions,
    dialogs: overrides.dialogs ?? createDialogService(),
    files: overrides.files ?? createFileService(),
    terminals,
    renderer,
  };
};
