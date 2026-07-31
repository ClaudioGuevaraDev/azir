import { useAppState } from './app/react';
import { selectIsBusy, selectNotices, selectWorkspace } from './app/state';
import { NoticeList } from './ui/NoticeList';
import { WelcomeScreen } from './workspace/WelcomeScreen';
import { WorkspaceShell } from './workspace/WorkspaceShell';

/**
 * Chooses between the welcome screen and the workspace, and nothing else.
 *
 * There is no data fetching, no effect and no local state here — the component
 * renders a projection of `AppState` and dispatches actions (invariant 3).
 */
export const App = (): React.JSX.Element => {
  const workspace = useAppState(selectWorkspace);
  const busy = useAppState(selectIsBusy);
  const notices = useAppState(selectNotices);

  return (
    <>
      {workspace.status === 'open' ? (
        <WorkspaceShell info={workspace.info} />
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
