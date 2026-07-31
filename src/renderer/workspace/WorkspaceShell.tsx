import type { WorkspaceInfo } from '@shared/ipc/contracts';
import { useDispatch } from '../app/react';
import { RepositoryPanel } from '../repository/RepositoryPanel';
import type { TerminalTransport } from '../terminal/controller';
import type { TerminalRegistry } from '../terminal/registry';
import { TerminalPanel } from '../terminal/TerminalPanel';
import './WorkspaceShell.css';

export interface WorkspaceShellProps {
  readonly info: WorkspaceInfo;
  readonly registry: TerminalRegistry;
  readonly transport: TerminalTransport;
}

/**
 * The workspace chrome: title bar, panel area, status bar.
 *
 * The panel area holds only the terminal for now. M3–M6 add the repository and
 * viewer panels, and M7 adds the layout engine that arranges all three — until then
 * this is a single slot, which is honest about what exists rather than a
 * three-column skeleton with two empty boxes.
 */
export const WorkspaceShell = ({
  info,
  registry,
  transport,
}: WorkspaceShellProps): React.JSX.Element => {
  const dispatch = useDispatch();

  return (
    <div className="shell" data-testid="workspace-shell">
      <header className="shell__bar">
        <div className="shell__identity">
          <span className="shell__name" data-testid="workspace-name">
            {info.name}
          </span>
          <span className="shell__root azir-selectable" title={info.root}>
            {info.root}
          </span>
        </div>

        <button
          type="button"
          className="shell__close"
          data-testid="close-workspace"
          onClick={() => dispatch({ type: 'workspace/closeRequested' })}
        >
          Close workspace
        </button>
      </header>

      {/*
        Two slots for now, side by side. The layout engine that arranges all three
        panels by configurable order and arrangement is M7; hard-coding a split here
        is honest about that rather than pretending the engine exists.
      */}
      <div className="shell__panels" data-testid="workspace-panels">
        <RepositoryPanel sessionId={info.sessionId} />
        <TerminalPanel sessionId={info.sessionId} registry={registry} transport={transport} />
      </div>

      <footer className="shell__status">
        <span className="shell__session">session {info.sessionId}</span>
      </footer>
    </div>
  );
};
