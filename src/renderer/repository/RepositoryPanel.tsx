import { memo, useCallback } from 'react';
import type { WorkspaceSessionId } from '@shared/ipc/contracts';
import { directoryRequested, directoryToggled, gitRefreshRequested } from '../app/actions';
import { useAppState, useDispatch } from '../app/react';
import type { GitState, RepositoryRow } from '../app/repository';
import { selectGit, selectRepositoryView, selectRows, selectSelectedPath } from '../app/state';
import { VirtualList } from '../ui/VirtualList';
import { gitBadgeOf } from './gitBadge';
import './RepositoryPanel.css';

/** Must match --azir-row-height in tokens.css; the virtual list needs a number. */
const ROW_HEIGHT = 22;

export interface RepositoryPanelProps {
  readonly sessionId: WorkspaceSessionId;
}

const indicator = (row: RepositoryRow): string => {
  if (row.kind === 'file') {
    return '';
  }
  if (row.childrenStatus === 'failed') {
    return '!';
  }
  if (row.childrenStatus === 'loading') {
    return '…';
  }
  return row.expanded ? '▾' : '▸';
};

/** Branch, ahead/behind, and the reason git is unavailable when it is. */
const GitSummary = ({
  git,
  onRetry,
}: {
  readonly git: GitState;
  readonly onRetry: () => void;
}): React.JSX.Element | null => {
  if (git.status === 'idle') {
    return null;
  }

  if (git.status === 'unavailable') {
    // Stated plainly and without a retry, because the condition is permanent for this
    // workspace. The tree above it keeps working — that is invariant 13.
    return (
      <div className="tree__git" data-state="unavailable" data-testid="git-unavailable">
        {git.error.message}
      </div>
    );
  }

  if (git.status === 'error') {
    return (
      <div className="tree__git" data-state="error" data-testid="git-error">
        <span>{git.error.message}</span>
        <button type="button" className="tree__git-retry" onClick={onRetry}>
          Retry
        </button>
      </div>
    );
  }

  if (git.status === 'loading') {
    return (
      <div className="tree__git" data-state="loading">
        Reading git status…
      </div>
    );
  }

  const { branch } = git;
  return (
    <div className="tree__git" data-state="ready" data-testid="git-branch">
      <span className="tree__branch">{branch.detached ? 'detached' : (branch.head ?? '—')}</span>
      {branch.commit === null && <span className="tree__git-note">no commits yet</span>}
      {branch.ahead > 0 && <span className="tree__ahead">↑{branch.ahead}</span>}
      {branch.behind > 0 && <span className="tree__behind">↓{branch.behind}</span>}
      <span className="tree__git-count" data-testid="git-change-count">
        {git.changed.length === 0 ? 'clean' : `${git.changed.length} changed`}
      </span>
    </div>
  );
};

/**
 * The repository panel.
 *
 * docs/architecture.md combines the filesystem and git into **one** projection viewed
 * several ways, rather than a separate explorer and a separate changes panel — so the
 * switch below changes the projection, not the panel, and the two views can never
 * disagree about what exists.
 *
 * Rows come from the memoised projection and are virtualised, so a render costs the
 * height of the window rather than the size of the repository.
 */
export const RepositoryPanel = memo(({ sessionId }: RepositoryPanelProps): React.JSX.Element => {
  const rows = useAppState(selectRows);
  const selectedPath = useAppState(selectSelectedPath);
  const view = useAppState(selectRepositoryView);
  const git = useAppState(selectGit);
  const dispatch = useDispatch();

  const refresh = useCallback(() => {
    dispatch(directoryRequested(sessionId, ''));
    dispatch(gitRefreshRequested(sessionId));
  }, [dispatch, sessionId]);

  const renderRow = useCallback(
    (row: RepositoryRow) => {
      const badge = gitBadgeOf(row.git);

      return (
        <button
          type="button"
          className="tree__row"
          data-kind={row.kind}
          data-selected={row.path === selectedPath}
          data-virtual={row.virtual}
          data-testid={`tree-row-${row.path}`}
          title={badge ? `${row.path} — ${badge.label}` : row.path}
          // Indentation is inline because it is data, not style: it comes from the
          // row's depth in the projection.
          style={{ paddingLeft: `calc(var(--azir-space-3) + ${row.depth} * 12px)` }}
          onClick={() => {
            dispatch({ type: 'repository/selected', path: row.path });
            if (row.kind === 'directory') {
              dispatch(directoryToggled(sessionId, row.path));
            }
          }}
        >
          <span className="tree__chevron">{indicator(row)}</span>
          <span className="tree__name" data-changed={badge !== null}>
            {row.name}
          </span>
          {/*
            A collapsed directory with changes underneath gets a dot. Without it an
            agent's edit three levels down is invisible until the user happens to
            expand the right folders.
          */}
          {row.containsChanges === true && !row.expanded && (
            <span className="tree__nested" data-testid={`tree-nested-${row.path}`} />
          )}
          {badge && (
            <span
              className="tree__badge"
              data-tone={badge.tone}
              data-staged-only={badge.stagedOnly}
              data-testid={`tree-badge-${row.path}`}
            >
              {badge.mark}
            </span>
          )}
        </button>
      );
    },
    [dispatch, sessionId, selectedPath],
  );

  const emptyMessage =
    view === 'changes'
      ? git.status === 'ready'
        ? 'No changes.'
        : 'Git status is unavailable.'
      : 'Reading folder…';

  return (
    <section className="tree" data-testid="repository-panel">
      <div className="tree__header">
        <div className="tree__views" role="tablist">
          {(['tree', 'changes'] as const).map((candidate) => (
            <button
              key={candidate}
              type="button"
              role="tab"
              aria-selected={view === candidate}
              className="tree__view"
              data-active={view === candidate}
              data-testid={`repository-view-${candidate}`}
              onClick={() => dispatch({ type: 'repository/viewChanged', view: candidate })}
            >
              {candidate === 'tree' ? 'Files' : 'Changes'}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="tree__refresh"
          aria-label="Refresh"
          data-testid="repository-refresh"
          // A manual refresh has to keep working even when the watcher is unavailable
          // (docs/architecture.md, Error handling).
          onClick={refresh}
        >
          ⟳
        </button>
      </div>

      <GitSummary git={git} onRetry={() => dispatch(gitRefreshRequested(sessionId))} />

      {rows.length === 0 ? (
        <p className="tree__empty">{emptyMessage}</p>
      ) : (
        <VirtualList
          items={rows}
          rowHeight={ROW_HEIGHT}
          className="tree__list"
          testId="repository-rows"
          keyOf={(row) => row.path}
          renderRow={renderRow}
        />
      )}
    </section>
  );
});

RepositoryPanel.displayName = 'RepositoryPanel';
