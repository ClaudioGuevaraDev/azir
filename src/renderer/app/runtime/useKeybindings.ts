import { useEffect } from 'react';
import type { WorkspaceSessionId } from '@shared/ipc/contracts';
import type { Panel } from '@shared/models/layout';
import { saveRequested, type Action } from '../actions';
import { matchBinding } from './keybindings';
import type { Dispatch } from '../store';

export interface KeybindingOptions {
  readonly dispatch: Dispatch;
  /** Read lazily: both change constantly and the listener is installed once. */
  readonly sessionId: () => WorkspaceSessionId | null;
  readonly overlayOpen: () => boolean;
  readonly panelInSlot: (slot: number) => Panel | undefined;
  readonly activePaneId: () => string | null;
  readonly focusedPanel: () => Panel;
  /** The active viewer tab's path, for the focus-scoped save shortcut. */
  readonly activeTabPath: () => string | null;
}

/**
 * Installs the application's reserved shortcuts.
 *
 * The listener runs in the **capture** phase on `window`, which is what puts it ahead of
 * xterm's own handler on its textarea. That ordering is the whole mechanism: a matched chord
 * is consumed here and never reaches the terminal, and everything else is left completely
 * untouched so the shell sees it exactly as it would in a real terminal.
 *
 * `preventDefault` is called only on a match. Calling it unconditionally — a tempting way to
 * stop the browser's own Ctrl+key behaviour — would break every keystroke the terminal needs.
 */
export const useKeybindings = (options: KeybindingOptions): void => {
  const {
    dispatch,
    sessionId,
    overlayOpen,
    panelInSlot,
    activePaneId,
    focusedPanel,
    activeTabPath,
  } = options;

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const command = matchBinding(
        {
          code: event.code,
          ctrlKey: event.ctrlKey,
          shiftKey: event.shiftKey,
          altKey: event.altKey,
          metaKey: event.metaKey,
        },
        overlayOpen(),
        focusedPanel(),
      );

      if (!command) {
        return;
      }

      const session = sessionId();
      let action: Action | null = null;

      switch (command.kind) {
        case 'focusSlot': {
          // The chord names a slot; the order setting says which panel that is.
          const panel = panelInSlot(command.slot);
          action = panel === undefined ? null : { type: 'focus/changed', panel };
          break;
        }
        case 'saveFile': {
          const tabPath = activeTabPath();
          action = session === null || tabPath === null ? null : saveRequested(session, tabPath);
          break;
        }
        case 'openWorkspace':
          action = { type: 'workspace/openRequested' };
          break;
        case 'newTerminal':
          action =
            session === null ? null : { type: 'terminal/createRequested', sessionId: session };
          break;
        case 'closeTerminal': {
          const paneId = activePaneId();
          action =
            session === null || paneId === null
              ? null
              : { type: 'terminal/closeRequested', sessionId: session, paneId };
          break;
        }
        case 'toggleHelp':
          action = overlayOpen()
            ? { type: 'overlay/closed' }
            : { type: 'overlay/opened', overlay: { type: 'help' } };
          break;
        case 'openSettings':
          action = { type: 'overlay/opened', overlay: { type: 'settings' } };
          break;
        case 'dismissOverlay':
          action = { type: 'overlay/closed' };
          break;
      }

      // Consumed even when the command turned out to be a no-op — Ctrl+Shift+T with no
      // workspace open must not fall through to the terminal as a control sequence.
      event.preventDefault();
      event.stopPropagation();

      if (action) {
        dispatch(action);
      }
    };

    window.addEventListener('keydown', onKeyDown, { capture: true });
    return () => {
      window.removeEventListener('keydown', onKeyDown, { capture: true });
    };
  }, [dispatch, sessionId, overlayOpen, panelInSlot, activePaneId, focusedPanel, activeTabPath]);
};
