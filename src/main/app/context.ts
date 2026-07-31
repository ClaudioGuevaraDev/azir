import { CHANNELS } from '@shared/ipc/channels';
import { createDialogService, type DialogService } from './dialogs';
import { createQuitGuard, type QuitGuard } from './quitGuard';
import { createRendererChannel, type RendererChannel } from './rendererChannel';
import { createFileService, type FileService } from '../filesystem/fileService';
import { createGitService, type GitService } from '../git/gitService';
import { createTerminalManager, type TerminalManager } from '../terminal/terminalManager';
import { createWatcherService, type WatcherService } from '../watcher/watcherService';
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
  readonly git: GitService;
  readonly terminals: TerminalManager;
  readonly watcher: WatcherService;
  readonly renderer: RendererChannel;
  readonly quitGuard: QuitGuard;
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

  const watcher =
    overrides.watcher ??
    createWatcherService({
      emit: (batch) => {
        renderer.send(CHANNELS.eventFsChanged, batch);
      },
      onFailure: (_sessionId, detail) => {
        // Logged, not surfaced as an error state: the spec requires that a watcher
        // failure not disable manual refresh, so the panel degrades rather than breaks.
        console.warn('[watcher] failed:', detail);
      },
    });

  // Closing a workspace releases everything it owned; closing the app releases the
  // rest from `before-quit`. Wiring it here rather than inside the registry keeps the
  // registry ignorant of terminals and watchers — it only knows something wants to be
  // told.
  sessions.onDispose((session) => {
    terminals.killSession(session.id);
    watcher.stop(session.id);
  });

  return {
    sessions,
    dialogs: overrides.dialogs ?? createDialogService(),
    files: overrides.files ?? createFileService(),
    git: overrides.git ?? createGitService(),
    terminals,
    watcher,
    renderer,
    quitGuard: overrides.quitGuard ?? createQuitGuard({ renderer }),
  };
};
