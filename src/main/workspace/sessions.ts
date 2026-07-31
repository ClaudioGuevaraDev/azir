import { stat } from 'node:fs/promises';
import type { WorkspaceInfo, WorkspaceSessionId } from '@shared/ipc/contracts';
import { describeError, err, ok, type Result } from '@shared/ipc/result';
import { normalizeRoot, resolveInside, workspaceName } from './paths';

/**
 * Owns workspace identity and lifetime for the main process.
 *
 * Two properties matter and are the whole reason this exists:
 *
 *  1. **Ids are minted here, never by the renderer, and never reused.** A stale
 *     in-flight response from workspace A can then be recognised and dropped
 *     rather than landing in workspace B (docs/architecture.md, Startup:
 *     "pending requests ignored").
 *  2. **Paths are resolved against the root this registry recorded**, not
 *     against a root the renderer supplied. That is what keeps file operations
 *     inside the active workspace even if the renderer is compromised.
 *
 * v1 has a single window and therefore at most one live session — opening a
 * second folder disposes the first. Disposal listeners are how the terminal
 * manager and, later, the watcher get told to release their resources.
 */

export interface WorkspaceSession {
  readonly id: WorkspaceSessionId;
  /** Normalised absolute path. The only root any path is ever resolved against. */
  readonly root: string;
  readonly name: string;
}

/**
 * Disposal is **synchronous**, deliberately.
 *
 * Shutdown is the constraint that forces it. Electron does not restart a quit
 * sequence: once a `will-quit` handler calls `preventDefault` to await async
 * cleanup, a later `app.quit()` from within that cycle is a no-op and the process
 * sits alive with no windows (measured, not assumed). Keeping disposal
 * synchronous means `before-quit` can release everything without ever preventing
 * the quit.
 *
 * This is not a compromise for the resources involved: `node-pty`'s `kill()` is
 * synchronous, and a watcher's `close()` can be fired without awaiting because
 * late events are filtered by session id anyway.
 */
export type SessionDisposeListener = (session: WorkspaceSession) => void;

export interface SessionRegistry {
  /** Validates the directory, disposes any current session, mints a new one. */
  open(rawPath: string): Promise<Result<WorkspaceInfo>>;
  /** Idempotent: closing an already-closed or unknown session returns false. */
  close(id: WorkspaceSessionId): boolean;
  closeAll(): void;
  current(): WorkspaceSession | undefined;
  /** The coarse staleness gate every session-scoped handler goes through. */
  require(id: WorkspaceSessionId): Result<WorkspaceSession>;
  /** `require` plus the path sandbox, which is the pair every file op needs. */
  resolve(id: WorkspaceSessionId, relativePosix: string): Result<string>;
  onDispose(listener: SessionDisposeListener): void;
}

export interface SessionRegistryOptions {
  /** Injected so tests need no real directories. */
  readonly statDirectory?: (absolutePath: string) => Promise<boolean>;
}

const defaultStatDirectory = async (absolutePath: string): Promise<boolean> => {
  const stats = await stat(absolutePath);
  return stats.isDirectory();
};

export const createSessionRegistry = (options: SessionRegistryOptions = {}): SessionRegistry => {
  const statDirectory = options.statDirectory ?? defaultStatDirectory;
  const disposeListeners: SessionDisposeListener[] = [];

  // Monotonic and never reset. Reusing an id would let a late event for a dead
  // session be accepted by its successor, which is exactly the class of bug the
  // id exists to prevent.
  let nextId: WorkspaceSessionId = 1;
  let session: WorkspaceSession | undefined;

  const dispose = (target: WorkspaceSession): void => {
    for (const listener of disposeListeners) {
      try {
        listener(target);
      } catch (error) {
        // One listener failing must not strand the others, or the resources they
        // own. Cleanup has to be best-effort and complete.
        console.error('[workspace] dispose listener failed:', error);
      }
    }
  };

  const toInfo = (target: WorkspaceSession): WorkspaceInfo => ({
    sessionId: target.id,
    root: target.root,
    name: target.name,
  });

  return {
    async open(rawPath) {
      const root = normalizeRoot(rawPath);

      let isDirectory: boolean;
      try {
        isDirectory = await statDirectory(root);
      } catch (error) {
        return err('not-found', 'That folder could not be opened.', describeError(error));
      }

      if (!isDirectory) {
        return err('not-a-file', 'That path is not a folder.');
      }

      // Dispose before minting, so a listener can never observe two live
      // sessions at once.
      if (session) {
        const previous = session;
        session = undefined;
        dispose(previous);
      }

      const opened: WorkspaceSession = {
        id: nextId,
        root,
        name: workspaceName(root),
      };
      nextId += 1;
      session = opened;

      return ok(toInfo(opened));
    },

    close(id) {
      if (!session || session.id !== id) {
        return false;
      }
      const previous = session;
      session = undefined;
      dispose(previous);
      return true;
    },

    closeAll() {
      if (!session) {
        return;
      }
      const previous = session;
      session = undefined;
      dispose(previous);
    },

    current() {
      return session;
    },

    require(id) {
      if (!session || session.id !== id) {
        return err('stale-session', 'That workspace is no longer open.');
      }
      return ok(session);
    },

    resolve(id, relativePosix) {
      if (!session || session.id !== id) {
        return err('stale-session', 'That workspace is no longer open.');
      }
      return resolveInside(session.root, relativePosix);
    },

    onDispose(listener) {
      disposeListeners.push(listener);
    },
  };
};
