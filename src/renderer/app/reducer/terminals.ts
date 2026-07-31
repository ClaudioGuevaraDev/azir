import type { TerminalPaneId } from '@shared/ipc/contracts';
import type { TerminalPaneState, TerminalsState } from '../state';
import { changed, idle, withEffects, type Reduction, type SliceReducer } from './combine';

/**
 * Terminal panes.
 *
 * docs/architecture.md's rules for this slice, and how each is met:
 *
 *  - *"pane IDs are stable"* and never reused: minted from `nextPaneSeq`, which is
 *    monotonic for the application's whole run and is not reset when a workspace
 *    closes. Minting inside the reducer is legitimate here, unlike a request id,
 *    because it is a pure function of prior state.
 *  - *"the collection is never empty while the workspace is active"*: opening a
 *    workspace starts a pane.
 *  - *"there is a fixed maximum"*: enforced here as well as in main, so the UI can
 *    disable the button rather than surface a failure.
 *  - *"hidden panes continue running"* and *"switching the active pane does not
 *    recreate xterm.js or node-pty"*: nothing in this slice destroys a pane on
 *    deactivation. Only an explicit close does.
 *
 * There is no output in this state. A hidden pane that produces output gets one
 * throttled bit, `hasUnreadOutput`.
 */

const MAX_PANES = 8;

const replacePane = (
  panes: readonly TerminalPaneState[],
  paneId: TerminalPaneId,
  update: (pane: TerminalPaneState) => TerminalPaneState,
): readonly TerminalPaneState[] | undefined => {
  const index = panes.findIndex((pane) => pane.id === paneId);
  if (index === -1) {
    return undefined;
  }
  const existing = panes[index];
  if (!existing) {
    return undefined;
  }
  const updated = update(existing);
  if (updated === existing) {
    return undefined;
  }
  const next = [...panes];
  next[index] = updated;
  return next;
};

/**
 * Chooses the pane to focus after the active one goes away: the next one to the
 * right, or the last if there is none. Falling back to index 0 would jump the user
 * across the tab strip.
 */
const neighbourOf = (
  panes: readonly TerminalPaneState[],
  removedIndex: number,
): TerminalPaneId | null => {
  if (panes.length === 0) {
    return null;
  }
  const index = Math.min(removedIndex, panes.length - 1);
  return panes[index]?.id ?? null;
};

export const terminalsReducer: SliceReducer<TerminalsState> = (
  state,
  action,
): Reduction<TerminalsState> => {
  switch (action.type) {
    case 'workspace/opened': {
      // Startup autostart: the spec's startup sequence ends with "create initial
      // PTY when autostart is enabled", and the panel must not be empty while a
      // workspace is active.
      const paneId = `p${state.nextPaneSeq}`;
      const pane: TerminalPaneState = {
        id: paneId,
        title: 'Terminal',
        lifecycle: 'starting',
        cwd: action.info.root,
        exitCode: null,
        hasUnreadOutput: false,
      };
      return withEffects(
        { panes: [pane], activePaneId: paneId, nextPaneSeq: state.nextPaneSeq + 1 },
        { type: 'terminal/create', sessionId: action.info.sessionId, paneId },
      );
    }

    case 'workspace/closed': {
      // Main kills the PTYs through the session's dispose listeners, so no kill
      // effects are emitted here — issuing them would race the teardown already in
      // progress and produce `unknown-pane` errors.
      if (state.panes.length === 0 && state.activePaneId === null) {
        return idle(state);
      }
      return changed({ ...state, panes: [], activePaneId: null });
    }

    case 'terminal/createRequested': {
      if (state.panes.length >= MAX_PANES) {
        return idle(state);
      }
      const paneId = `p${state.nextPaneSeq}`;
      const pane: TerminalPaneState = {
        id: paneId,
        title: 'Terminal',
        lifecycle: 'starting',
        cwd: '',
        exitCode: null,
        hasUnreadOutput: false,
      };
      return withEffects(
        {
          panes: [...state.panes, pane],
          activePaneId: paneId,
          nextPaneSeq: state.nextPaneSeq + 1,
        },
        { type: 'terminal/create', sessionId: action.sessionId, paneId },
      );
    }

    case 'terminal/created': {
      const panes = replacePane(state.panes, action.paneId, (pane) => ({
        ...pane,
        lifecycle: 'running',
        cwd: action.cwd,
        title: shellTitle(action.shellPath),
      }));
      // A response for a pane that has already been closed is dropped rather than
      // resurrecting it.
      return panes ? changed({ ...state, panes }) : idle(state);
    }

    case 'terminal/createFailed': {
      const panes = replacePane(state.panes, action.paneId, (pane) => ({
        ...pane,
        lifecycle: 'failed',
        error: action.error,
      }));
      return panes ? changed({ ...state, panes }) : idle(state);
    }

    case 'terminal/exited': {
      // The pane is kept, showing its exit code. A shell that dies because a
      // command called `exit` should leave visible evidence, not vanish.
      const panes = replacePane(state.panes, action.paneId, (pane) => ({
        ...pane,
        lifecycle: 'exited',
        exitCode: action.exitCode,
      }));
      return panes ? changed({ ...state, panes }) : idle(state);
    }

    case 'terminal/closeRequested': {
      const index = state.panes.findIndex((pane) => pane.id === action.paneId);
      if (index === -1) {
        return idle(state);
      }
      const panes = state.panes.filter((pane) => pane.id !== action.paneId);
      const activePaneId =
        state.activePaneId === action.paneId ? neighbourOf(panes, index) : state.activePaneId;

      return withEffects(
        { ...state, panes, activePaneId },
        { type: 'terminal/kill', sessionId: action.sessionId, paneId: action.paneId },
      );
    }

    case 'terminal/activated': {
      if (state.activePaneId === action.paneId) {
        // Still clear the unread marker: activating an already-active pane is what
        // a click on it means.
        const panes = replacePane(state.panes, action.paneId, (pane) =>
          pane.hasUnreadOutput ? { ...pane, hasUnreadOutput: false } : pane,
        );
        return panes ? changed({ ...state, panes }) : idle(state);
      }
      if (!state.panes.some((pane) => pane.id === action.paneId)) {
        return idle(state);
      }
      const panes =
        replacePane(state.panes, action.paneId, (pane) =>
          pane.hasUnreadOutput ? { ...pane, hasUnreadOutput: false } : pane,
        ) ?? state.panes;
      return changed({ ...state, panes, activePaneId: action.paneId });
    }

    case 'terminal/activity': {
      // The active pane's output is already on screen; marking it unread would make
      // the indicator meaningless.
      if (state.activePaneId === action.paneId) {
        return idle(state);
      }
      const panes = replacePane(state.panes, action.paneId, (pane) =>
        pane.hasUnreadOutput ? pane : { ...pane, hasUnreadOutput: true },
      );
      return panes ? changed({ ...state, panes }) : idle(state);
    }

    default:
      return idle(state);
  }
};

/** `C:\Program Files\Git\bin\bash.exe` → `bash`. */
const shellTitle = (shellPath: string): string => {
  const base = shellPath.split(/[\\/]/).pop() ?? shellPath;
  return base.replace(/\.exe$/i, '') || 'Terminal';
};
