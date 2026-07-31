import { useEffect, useMemo, useRef } from 'react';
import type { Panel } from '@shared/models/layout';
import { slotOf } from '../app/chrome';
import { useAppState, useDispatch } from '../app/react';
import { selectFocusedPanel, selectLayout } from '../app/state';
import { computeLayout } from './engine';
import './WorkspaceLayout.css';

export interface WorkspaceLayoutProps {
  /** One renderer per panel; which slot each lands in comes from the settings. */
  readonly render: (panel: Panel) => React.ReactNode;
}

/**
 * Places the three panels according to the layout engine.
 *
 * The engine is a pure function of geometry, arrangement and focus, so this component does
 * two things and no more: it measures the available area and it positions what the engine
 * returned. It deliberately does not decide anything — that separation is what makes the
 * degradation rules assertable without a browser.
 *
 * A hidden panel is unmounted rather than hidden with CSS, which is the opposite of what
 * the terminal panes do. The reasoning is the reverse too: a pane holds a live PTY and its
 * scrollback, so unmounting would destroy state the user cannot get back; a panel is a
 * projection of the store, so remounting costs a render and nothing else. The terminal
 * *panel* keeps its PTYs regardless, because those live in the main process.
 */
export const WorkspaceLayout = ({ render }: WorkspaceLayoutProps): React.JSX.Element => {
  const layout = useAppState(selectLayout);
  const focused = useAppState(selectFocusedPanel);
  const dispatch = useDispatch();
  const hostRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }
    // Measured from the panel area rather than the window, because the title and status bars
    // take height the engine must not count.
    const observer = new ResizeObserver(() => {
      dispatch({
        type: 'layout/resized',
        width: host.clientWidth,
        height: host.clientHeight,
      });
    });
    observer.observe(host);
    dispatch({ type: 'layout/resized', width: host.clientWidth, height: host.clientHeight });
    return () => {
      observer.disconnect();
    };
  }, [dispatch]);

  const computed = useMemo(
    () =>
      computeLayout({
        width: layout.width,
        height: layout.height,
        arrangement: layout.settings.arrangement,
        focusedSlot: Math.max(0, slotOf(layout.settings, focused)),
      }),
    [layout.width, layout.height, layout.settings, focused],
  );

  return (
    <div
      className="stage"
      ref={hostRef}
      data-testid="workspace-stage"
      data-degraded={computed.degraded}
    >
      {computed.visibleSlots.map((slot) => {
        const panel = layout.settings.order[slot];
        const rect = computed.rects.get(slot);
        if (panel === undefined || rect === undefined) {
          return null;
        }

        return (
          <div
            key={panel}
            className="stage__slot"
            data-panel={panel}
            data-slot={slot}
            data-focused={panel === focused}
            data-testid={`panel-${panel}`}
            style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
            // Capture, so focus follows a click anywhere in the panel including inside
            // xterm, which stops propagation of its own events.
            onFocusCapture={() => dispatch({ type: 'focus/changed', panel })}
            onMouseDownCapture={() => dispatch({ type: 'focus/changed', panel })}
          >
            {render(panel)}
          </div>
        );
      })}
    </div>
  );
};
