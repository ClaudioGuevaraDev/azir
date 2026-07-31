import { memo, useCallback } from 'react';
import type { WorkspaceSessionId } from '@shared/ipc/contracts';
import { directoryRequested, directoryToggled } from '../app/actions';
import { useAppState, useDispatch } from '../app/react';
import type { RepositoryRow } from '../app/repository';
import { selectRepositoryView, selectRows, selectSelectedPath } from '../app/state';
import { VirtualList } from '../ui/VirtualList';
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

/**
 * The repository panel.
 *
 * docs/architecture.md combines the filesystem and git into one projection viewed
 * several ways, rather than a separate explorer and changes panel — so the view
 * switch here changes the projection, not the panel. `changes` lands with git in M4.
 *
 * Rows come from the memoised projection and are virtualised, so the cost of a
 * render is proportional to the height of the window rather than to the size of the
 * repository.
 */
export const RepositoryPanel = memo(({ sessionId }: RepositoryPanelProps): React.JSX.Element => {
  const rows = useAppState(selectRows);
  const selectedPath = useAppState(selectSelectedPath);
  const view = useAppState(selectRepositoryView);
  const dispatch = useDispatch();

  const renderRow = useCallback(
    (row: RepositoryRow) => (
      <button
        type="button"
        className="tree__row"
        data-kind={row.kind}
        data-selected={row.path === selectedPath}
        data-testid={`tree-row-${row.path}`}
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
        <span className="tree__name">{row.name}</span>
      </button>
    ),
    [dispatch, sessionId, selectedPath],
  );

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
          // A manual refresh has to keep working even when the watcher is
          // unavailable (docs/architecture.md, Error handling).
          onClick={() => dispatch(directoryRequested(sessionId, ''))}
        >
          ⟳
        </button>
      </div>

      {view === 'changes' ? (
        <p className="tree__empty" data-testid="repository-changes-placeholder">
          Git status arrives in the next milestone.
        </p>
      ) : rows.length === 0 ? (
        <p className="tree__empty">Reading folder…</p>
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
