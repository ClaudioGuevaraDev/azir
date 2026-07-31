import { useAppState } from './app/react';
import { selectIsBusy, selectNotices, selectWorkspace } from './app/state';
import type { TerminalTransport } from './terminal/controller';
import type { TerminalRegistry } from './terminal/registry';
import { NoticeList } from './ui/NoticeList';
import { WelcomeScreen } from './workspace/WelcomeScreen';
import { WorkspaceShell } from './workspace/WorkspaceShell';

export interface AppProps {
  /** Both are singletons created outside React in main.tsx. */
  readonly registry: TerminalRegistry;
  readonly transport: TerminalTransport;
}

/**
 * Chooses between the welcome screen and the workspace, and nothing else.
 *
 * There is no data fetching, no effect and no local state here — the component
 * renders a projection of `AppState` and dispatches actions (invariant 3).
 *
 * The registry and transport are threaded through as props rather than read from a
 * module global so that tests can substitute them, which is what makes the
 * "terminal output causes no re-render" assertion possible.
 */
export const App = ({ registry, transport }: AppProps): React.JSX.Element => {
  const workspace = useAppState(selectWorkspace);
  const busy = useAppState(selectIsBusy);
  const notices = useAppState(selectNotices);

  return (
    <>
      {workspace.status === 'open' ? (
        <WorkspaceShell info={workspace.info} registry={registry} transport={transport} />
      ) : (
        <WelcomeScreen
          busy={busy}
          {...(workspace.status === 'failed' ? { error: workspace.error } : {})}
        />
      )}
      <NoticeList notices={notices} />
    </>
  );
};
