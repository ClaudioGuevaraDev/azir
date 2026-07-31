import { memo } from 'react';
import type { WorkspaceSessionId } from '@shared/ipc/contracts';
import { useAppState, useDispatch } from '../app/react';
import { selectActivePaneId, selectPanes, type TerminalPaneState } from '../app/state';
import type { TerminalTransport } from './controller';
import type { TerminalRegistry } from './registry';
import { TerminalPane } from './TerminalPane';
import './TerminalPanel.css';

const MAX_PANES = 8;

export interface TerminalPanelProps {
  readonly sessionId: WorkspaceSessionId;
  readonly registry: TerminalRegistry;
  readonly transport: TerminalTransport;
}

const paneLabel = (pane: TerminalPaneState): string => {
  if (pane.lifecycle === 'exited') {
    return `${pane.title} (exit ${pane.exitCode ?? '?'})`;
  }
  if (pane.lifecycle === 'failed') {
    return `${pane.title} (failed)`;
  }
  return pane.title;
};

/**
 * The terminal panel: one tab strip, several live PTYs.
 *
 * docs/architecture.md keeps the terminal as a single workspace panel even when it
 * holds several PTYs, so this is one component with a tab strip rather than
 * separately placed panels.
 *
 * Memoised on the pane list and the active id — which are the only two things it
 * renders. Since terminal output never enters state, neither changes while a shell
 * is producing output, so this subtree does not re-render during a build log. The
 * assertion that this holds lives in TerminalPanel.test.tsx.
 */
export const TerminalPanel = memo(
  ({ sessionId, registry, transport }: TerminalPanelProps): React.JSX.Element => {
    const panes = useAppState(selectPanes);
    const activePaneId = useAppState(selectActivePaneId);
    const dispatch = useDispatch();

    return (
      <section className="terminals" data-testid="terminal-panel">
        <div className="terminals__tabs" role="tablist">
          {panes.map((pane) => (
            <div
              key={pane.id}
              className="terminals__tab"
              role="tab"
              aria-selected={pane.id === activePaneId}
              data-active={pane.id === activePaneId}
              data-lifecycle={pane.lifecycle}
              data-testid={`terminal-tab-${pane.id}`}
            >
              <button
                type="button"
                className="terminals__select"
                onClick={() => dispatch({ type: 'terminal/activated', paneId: pane.id })}
              >
                {pane.hasUnreadOutput && (
                  <span
                    className="terminals__unread"
                    data-testid={`terminal-unread-${pane.id}`}
                    aria-label="unread output"
                  />
                )}
                {paneLabel(pane)}
              </button>
              <button
                type="button"
                className="terminals__close"
                aria-label={`Close ${pane.title}`}
                data-testid={`terminal-close-${pane.id}`}
                onClick={() =>
                  dispatch({ type: 'terminal/closeRequested', sessionId, paneId: pane.id })
                }
              >
                ×
              </button>
            </div>
          ))}

          <button
            type="button"
            className="terminals__add"
            aria-label="New terminal"
            data-testid="terminal-add"
            disabled={panes.length >= MAX_PANES}
            onClick={() => dispatch({ type: 'terminal/createRequested', sessionId })}
          >
            +
          </button>
        </div>

        <div className="terminals__surface">
          {panes.map((pane) => (
            <TerminalPane
              key={pane.id}
              sessionId={sessionId}
              paneId={pane.id}
              active={pane.id === activePaneId}
              registry={registry}
              transport={transport}
            />
          ))}

          {panes.length === 0 && (
            <p className="terminals__empty">No terminals. Press + to start one.</p>
          )}
        </div>
      </section>
    );
  },
);

TerminalPanel.displayName = 'TerminalPanel';
