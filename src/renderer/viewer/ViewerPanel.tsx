import { memo, useCallback } from 'react';
import type { DiffTarget, WorkspaceSessionId } from '@shared/ipc/contracts';
import { diffTargetChanged, tabActivated, viewerModeChanged } from '../app/actions';
import { useAppState, useDispatch } from '../app/react';
import { selectActiveTab, selectActiveTabGitStatus, selectViewerTabs } from '../app/state';
import { countDiffChanges, isUntracked, synthesizeAddedDiff, type ViewerTab } from '../app/viewer';
import { CodeView } from './CodeView';
import { DiffView } from './DiffView';
import './ViewerPanel.css';

export interface ViewerPanelProps {
  readonly sessionId: WorkspaceSessionId;
}

const basename = (path: string): string => path.split('/').pop() ?? path;

/**
 * The code viewer.
 *
 * Read-only for now: the spec's limited edit mode is M7. What it has to get right today
 * is the review half of the product loop — read the file, read what changed — and the
 * states around that: a file too large to load, a binary file, a file that moved on disk
 * while you were looking at something else.
 */
export const ViewerPanel = memo(({ sessionId }: ViewerPanelProps): React.JSX.Element => {
  const tabs = useAppState(selectViewerTabs);
  const tab = useAppState(selectActiveTab);
  const gitStatus = useAppState(selectActiveTabGitStatus);
  const dispatch = useDispatch();

  const onCodeScroll = useCallback(
    (top: number) => {
      if (tab) {
        dispatch({ type: 'viewer/scrolled', path: tab.path, mode: 'code', top });
      }
    },
    [dispatch, tab],
  );

  const onDiffScroll = useCallback(
    (top: number) => {
      if (tab) {
        dispatch({ type: 'viewer/scrolled', path: tab.path, mode: 'diff', top });
      }
    },
    [dispatch, tab],
  );

  return (
    <section className="viewer" data-testid="viewer-panel">
      <div className="viewer__tabs" role="tablist">
        {tabs.map((candidate) => (
          <div
            key={candidate.path}
            className="viewer__tab"
            role="tab"
            aria-selected={candidate.path === tab?.path}
            data-active={candidate.path === tab?.path}
            data-testid={`viewer-tab-${candidate.path}`}
          >
            <button
              type="button"
              className="viewer__select"
              title={candidate.path}
              onClick={() => dispatch(tabActivated(sessionId, candidate.path))}
            >
              {/* The one thing a background tab reports: its file moved underneath it. */}
              {candidate.stale && (
                <span
                  className="viewer__stale"
                  data-testid={`viewer-stale-${candidate.path}`}
                  aria-label="changed on disk"
                />
              )}
              {basename(candidate.path)}
            </button>
            <button
              type="button"
              className="viewer__close"
              aria-label={`Close ${basename(candidate.path)}`}
              data-testid={`viewer-close-${candidate.path}`}
              onClick={() => dispatch({ type: 'viewer/closed', path: candidate.path })}
            >
              ×
            </button>
          </div>
        ))}
      </div>

      {tab === undefined ? (
        <p className="viewer__message" data-testid="viewer-empty">
          Select a file to read it.
        </p>
      ) : (
        <ViewerBody
          sessionId={sessionId}
          tab={tab}
          untracked={isUntracked(gitStatus)}
          hasStaged={gitStatus?.staged !== null && gitStatus?.staged !== undefined}
          onCodeScroll={onCodeScroll}
          onDiffScroll={onDiffScroll}
        />
      )}
    </section>
  );
});

ViewerPanel.displayName = 'ViewerPanel';

interface ViewerBodyProps {
  readonly sessionId: WorkspaceSessionId;
  readonly tab: ViewerTab;
  readonly untracked: boolean;
  readonly hasStaged: boolean;
  readonly onCodeScroll: (top: number) => void;
  readonly onDiffScroll: (top: number) => void;
}

const ViewerBody = ({
  sessionId,
  tab,
  untracked,
  hasStaged,
  onCodeScroll,
  onDiffScroll,
}: ViewerBodyProps): React.JSX.Element => {
  const dispatch = useDispatch();

  /*
   * An untracked file has no diff — `git diff` compares against the index, and the index
   * has never heard of it. Showing an empty diff for a file an agent just created would
   * be the least useful possible answer, so the content is projected as all additions.
   */
  const document = tab.content.status === 'ready' ? tab.content.value : undefined;
  const effectiveDiff =
    untracked && document !== undefined
      ? synthesizeAddedDiff(tab.path, document, tab.diffTarget)
      : tab.diff.status === 'ready'
        ? tab.diff.value
        : undefined;

  const counts = effectiveDiff ? countDiffChanges(effectiveDiff) : null;

  return (
    <>
      <div className="viewer__bar">
        <span className="viewer__path azir-selectable" title={tab.path}>
          {tab.path}
        </span>

        <div className="viewer__modes" role="group">
          {(['code', 'diff'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              className="viewer__mode"
              data-active={tab.mode === mode}
              data-testid={`viewer-mode-${mode}`}
              onClick={() => dispatch(viewerModeChanged(sessionId, tab.path, mode))}
            >
              {mode === 'code' ? 'Code' : 'Diff'}
            </button>
          ))}
        </div>

        {/*
          The staged/worktree switch appears only when the file actually has both sides.
          Showing it always would offer a choice that makes no difference for most files.
        */}
        {tab.mode === 'diff' && hasStaged && !untracked && (
          <div className="viewer__modes" role="group">
            {(['worktree', 'staged'] as const).map((target: DiffTarget) => (
              <button
                key={target}
                type="button"
                className="viewer__mode"
                data-active={tab.diffTarget === target}
                data-testid={`viewer-target-${target}`}
                onClick={() => dispatch(diffTargetChanged(sessionId, tab.path, target))}
              >
                {target === 'worktree' ? 'Unstaged' : 'Staged'}
              </button>
            ))}
          </div>
        )}

        {tab.mode === 'diff' && counts && (
          <span className="viewer__counts" data-testid="viewer-counts">
            <span className="viewer__added">+{counts.added}</span>
            <span className="viewer__removed">−{counts.removed}</span>
          </span>
        )}

        {document && (
          <span className="viewer__meta">
            {document.lines.length} lines · {document.eol.toUpperCase()}
          </span>
        )}
      </div>

      {tab.content.status === 'loading' && <p className="viewer__message">Reading…</p>}

      {tab.content.status === 'error' && (
        <p className="viewer__message" data-error data-testid="viewer-error">
          {tab.content.error.message}
        </p>
      )}

      {tab.mode === 'code' && document && (
        <CodeView document={document} initialTop={tab.codeTop} onScroll={onCodeScroll} />
      )}

      {tab.mode === 'diff' && (
        <>
          {tab.diff.status === 'loading' && !untracked && (
            <p className="viewer__message">Reading diff…</p>
          )}
          {tab.diff.status === 'error' && !untracked && (
            <p className="viewer__message" data-error data-testid="viewer-diff-error">
              {tab.diff.error.message}
            </p>
          )}
          {effectiveDiff && (
            <DiffView diff={effectiveDiff} initialTop={tab.diffTop} onScroll={onDiffScroll} />
          )}
        </>
      )}
    </>
  );
};
