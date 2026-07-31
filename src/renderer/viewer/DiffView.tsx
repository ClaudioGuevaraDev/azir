import { useCallback } from 'react';
import type { FileDiff } from '@shared/ipc/contracts';
import { projectDiffRows, type DiffRow } from '../app/viewer';
import { VirtualList } from '../ui/VirtualList';

export interface DiffViewProps {
  readonly diff: FileDiff;
  readonly initialTop: number;
  /** Row height in pixels, derived from the code font size setting. See CodeView. */
  readonly lineHeight: number;
  readonly onScroll: (top: number) => void;
}

const MARKS = { add: '+', remove: '-', context: ' ' } as const;

/**
 * A unified diff, virtualised.
 *
 * Unified rather than side-by-side: the panel is one third of the window next to a tree
 * and a terminal, and a split view in that width truncates both sides. Line numbers for
 * the old and new file are shown in separate gutters so a removal and an addition at the
 * same position stay distinguishable.
 *
 * Hunk headers are rows in the same list rather than sticky elements outside it, because
 * fixed-height windowing needs every row to be the same height.
 */
export const DiffView = ({
  diff,
  initialTop,
  lineHeight,
  onScroll,
}: DiffViewProps): React.JSX.Element => {
  const rows = projectDiffRows(diff);

  const renderRow = useCallback(
    (row: DiffRow) =>
      row.kind === 'hunk' ? (
        <div className="diff__hunk">
          <span className="diff__hunk-label">{row.label}</span>
          {row.heading !== '' && <span className="diff__hunk-heading">{row.heading}</span>}
        </div>
      ) : (
        <div className="diff__line" data-kind={row.line.kind}>
          <span className="diff__gutter">{row.line.oldNumber ?? ''}</span>
          <span className="diff__gutter">{row.line.newNumber ?? ''}</span>
          <span className="diff__mark">{MARKS[row.line.kind]}</span>
          <span className="diff__text azir-selectable">
            {row.line.text === '' ? '​' : row.line.text}
          </span>
          {row.line.noNewline === true && (
            <span className="diff__no-newline" title="No newline at end of file">
              ↵
            </span>
          )}
        </div>
      ),
    [],
  );

  if (diff.binary) {
    return (
      <p className="viewer__message" data-testid="diff-binary">
        Binary file — git reports it changed but cannot show a line-by-line diff.
      </p>
    );
  }

  if (rows.length === 0) {
    return (
      <p className="viewer__message" data-testid="diff-empty">
        No changes against {diff.target === 'staged' ? 'HEAD' : 'the index'}.
      </p>
    );
  }

  return (
    <VirtualList
      items={rows}
      rowHeight={lineHeight}
      className="diff"
      testId="diff-view"
      initialTop={initialTop}
      onScrollTop={onScroll}
      keyOf={(row) => row.key}
      renderRow={renderRow}
    />
  );
};
