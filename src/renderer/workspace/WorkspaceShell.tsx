import type { WorkspaceInfo } from '@shared/ipc/contracts';
import { useDispatch } from '../app/react';
import './WorkspaceShell.css';

export interface WorkspaceShellProps {
  readonly info: WorkspaceInfo;
}

/**
 * The workspace chrome: title bar, panel area, status bar.
 *
 * M2 fills the panel area with the terminal; M3–M6 add the repository and viewer
 * panels. The layout engine that arranges them arrives in M7 — until then the
 * area is a single slot, which is honest about what exists rather than a
 * three-column skeleton with two empty boxes.
 */
export const WorkspaceShell = ({ info }: WorkspaceShellProps): React.JSX.Element => {
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

      <div className="shell__panels" data-testid="workspace-panels" />

      <footer className="shell__status">
        <span className="shell__session">session {info.sessionId}</span>
      </footer>
    </div>
  );
};
