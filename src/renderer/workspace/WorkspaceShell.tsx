import { useCallback } from 'react';
import type { WorkspaceInfo } from '@shared/ipc/contracts';
import type { Panel } from '@shared/models/layout';
import { panelInSlot } from '../app/chrome';
import { useAppState, useDispatch, useStore } from '../app/react';
import { useKeybindings } from '../app/runtime/useKeybindings';
import { selectFocusedPanel, selectLayout } from '../app/state';
import { WorkspaceLayout } from '../layout/WorkspaceLayout';
import { OverlayHost } from '../overlays/OverlayHost';
import { RepositoryPanel } from '../repository/RepositoryPanel';
import type { TerminalTransport } from '../terminal/controller';
import type { TerminalRegistry } from '../terminal/registry';
import { TerminalPanel } from '../terminal/TerminalPanel';
import { ViewerPanel } from '../viewer/ViewerPanel';
import './WorkspaceShell.css';

export interface WorkspaceShellProps {
  readonly info: WorkspaceInfo;
  readonly registry: TerminalRegistry;
  readonly transport: TerminalTransport;
}

/**
 * The workspace chrome: title bar, the layout stage, status bar, overlays.
 *
 * The stage places panels from the layout engine's rectangles; this component only says
 * which component belongs to which panel name. That indirection is what makes panel order a
 * setting rather than a rewrite.
 */
export const WorkspaceShell = ({
  info,
  registry,
  transport,
}: WorkspaceShellProps): React.JSX.Element => {
  const dispatch = useDispatch();
  const store = useStore();
  const layout = useAppState(selectLayout);
  const focused = useAppState(selectFocusedPanel);

  // Read lazily from the store rather than through selectors, so installing the listener
  // does not have to be redone every time any of these change.
  useKeybindings({
    dispatch,
    sessionId: useCallback(() => {
      const state = store.getState();
      return state.workspace.status === 'open' ? state.workspace.info.sessionId : null;
    }, [store]),
    overlayOpen: useCallback(() => store.getState().overlays.current !== null, [store]),
    panelInSlot: useCallback(
      (slot: number) => panelInSlot(store.getState().layout.settings, slot),
      [store],
    ),
    activePaneId: useCallback(() => store.getState().terminals.activePaneId, [store]),
    focusedPanel: useCallback(() => store.getState().focus.panel, [store]),
    activeTabPath: useCallback(() => store.getState().viewer.activePath, [store]),
  });

  const renderPanel = useCallback(
    (panel: Panel): React.ReactNode => {
      switch (panel) {
        case 'repository':
          return <RepositoryPanel sessionId={info.sessionId} />;
        case 'viewer':
          return <ViewerPanel sessionId={info.sessionId} />;
        case 'terminal':
          return (
            <TerminalPanel sessionId={info.sessionId} registry={registry} transport={transport} />
          );
      }
    },
    [info.sessionId, registry, transport],
  );

  return (
    <div className="shell" data-testid="workspace-shell">
      <header className="shell__bar">
        <div className="shell__identity">
          {/*
            The one piece of chrome that is not about the workspace. It is `aria-hidden` because
            the window title already announces the application, and a screen reader meeting "AZIR"
            before the folder name learns nothing it did not have.
          */}
          <span className="shell__mark" aria-hidden="true">
            Azir
          </span>
          <span className="shell__name" data-testid="workspace-name">
            {info.name}
          </span>
          <span className="shell__root azir-selectable" title={info.root}>
            {info.root}
          </span>
        </div>

        <div className="shell__actions">
          <button
            type="button"
            className="shell__action"
            data-testid="open-settings"
            onClick={() => dispatch({ type: 'overlay/opened', overlay: { type: 'settings' } })}
          >
            Settings
          </button>
          <button
            type="button"
            className="shell__action"
            data-testid="open-help"
            onClick={() => dispatch({ type: 'overlay/opened', overlay: { type: 'help' } })}
          >
            ?
          </button>
          <button
            type="button"
            className="shell__close"
            data-testid="close-workspace"
            onClick={() => dispatch({ type: 'workspace/closeRequested' })}
          >
            Close workspace
          </button>
        </div>
      </header>

      <WorkspaceLayout render={renderPanel} />

      <footer className="shell__status">
        <span className="shell__session">session {info.sessionId}</span>
        <span className="shell__focus" data-testid="status-focus">
          {focused}
        </span>
        <span className="shell__arrangement" data-testid="status-arrangement">
          {layout.settings.arrangement}
        </span>
        <span className="shell__hint">F1 for shortcuts</span>
      </footer>

      <OverlayHost />
    </div>
  );
};
