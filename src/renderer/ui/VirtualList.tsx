import { useCallback, useEffect, useRef, useState } from 'react';

export interface VirtualListProps<T> {
  readonly items: readonly T[];
  readonly rowHeight: number;
  readonly renderRow: (item: T, index: number) => React.ReactNode;
  readonly keyOf: (item: T, index: number) => string;
  readonly className?: string;
  readonly testId?: string;
  /** Rows rendered beyond the viewport, so a fast scroll does not show gaps. */
  readonly overscan?: number;
  /**
   * Scroll offset to restore on mount.
   *
   * The viewer keeps one per mode so switching between code and diff and back does not
   * lose the reader's place — the two have unrelated line counts, so a single shared
   * offset would land somewhere arbitrary.
   */
  readonly initialTop?: number;
  /** Reported so the owner can persist the offset. */
  readonly onScrollTop?: (top: number) => void;
}

/**
 * Fixed-height windowing.
 *
 * Performance rule 11 requires virtualisation for large lists, and a repository can
 * easily have thousands of visible rows once a few directories are open. Rendering
 * all of them costs a DOM node per row and makes every state change proportional to
 * the size of the repository rather than to the size of the window.
 *
 * Hand-written rather than pulled from a library because the requirement here is the
 * simple case: every row is exactly one design-token tall. A general virtualiser
 * solves variable heights, horizontal windowing and dynamic measurement, none of
 * which this needs — that is invariant 15 applied to dependencies.
 */
export const VirtualList = <T,>({
  items,
  rowHeight,
  renderRow,
  keyOf,
  className,
  testId,
  overscan = 8,
  initialTop = 0,
  onScrollTop,
}: VirtualListProps<T>): React.JSX.Element => {
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [scrollTop, setScrollTop] = useState(initialTop);
  const [viewportHeight, setViewportHeight] = useState(0);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    // ResizeObserver rather than a window resize listener: the panel changes height
    // when the layout changes, not only when the window does.
    const observer = new ResizeObserver(() => {
      setViewportHeight(viewport.clientHeight);
    });
    observer.observe(viewport);
    setViewportHeight(viewport.clientHeight);
    return () => {
      observer.disconnect();
    };
  }, []);

  // Applied once on mount rather than kept in sync with the prop: after that the DOM is
  // the authority, and writing `scrollTop` on every render would fight the user's wheel.
  useEffect(() => {
    if (initialTop > 0 && viewportRef.current) {
      viewportRef.current.scrollTop = initialTop;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onScroll = useCallback(
    (event: React.UIEvent<HTMLDivElement>) => {
      const { scrollTop: top } = event.currentTarget;
      setScrollTop(top);
      onScrollTop?.(top);
    },
    [onScrollTop],
  );

  const total = items.length;
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  // `+ 2` covers the partially visible row at each edge.
  const visibleCount = Math.ceil(viewportHeight / rowHeight) + overscan * 2 + 2;
  const last = Math.min(total, first + visibleCount);
  const window_ = items.slice(first, last);

  return (
    <div
      ref={viewportRef}
      className={className}
      onScroll={onScroll}
      data-testid={testId}
      role="tree"
    >
      {/* Sized to the full list so the scrollbar reflects the real length. */}
      <div style={{ height: total * rowHeight, position: 'relative' }}>
        <div style={{ transform: `translateY(${first * rowHeight}px)` }}>
          {window_.map((item, index) => (
            <div key={keyOf(item, first + index)} style={{ height: rowHeight }}>
              {renderRow(item, first + index)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
