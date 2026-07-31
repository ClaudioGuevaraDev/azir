import type { WorkspaceInfo } from '@shared/ipc/contracts';
import { useDispatch } from '../app/react';
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
        The spec's `sidebar-and-stack` arrangement, hard-coded. The layout engine that
        makes order and arrangement configurable — and degrades to two panels and then to
        one as the window shrinks — is M7; wiring a fixed split here is honest about that
        rather than pretending the engine exists.

        This particular arrangement is the useful one for supervision: the tree is a
        narrow index, the viewer is where reading happens and gets the space, and the
        terminal sits under it where its output lines up with the file above.
      */}
      <div className="shell__panels" data-testid="workspace-panels">
        <RepositoryPanel sessionId={info.sessionId} />
        <div className="shell__stack">
          <ViewerPanel sessionId={info.sessionId} />
          <TerminalPanel sessionId={info.sessionId} registry={registry} transport={transport} />
        </div>
      </div>

      <footer className="shell__status">
        <span className="shell__session">session {info.sessionId}</span>
      </footer>
    </div>
  );
};
