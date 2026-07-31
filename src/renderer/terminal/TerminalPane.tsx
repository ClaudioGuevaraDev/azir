import { useEffect, useRef } from 'react';
import type { TerminalPaneId, WorkspaceSessionId } from '@shared/ipc/contracts';
import { createTerminalController, type TerminalController } from './controller';
import { readTerminalFontFamily, readTerminalTheme } from './theme';
import type { TerminalRegistry } from './registry';
import type { TerminalTransport } from './controller';

export interface TerminalPaneProps {
  readonly sessionId: WorkspaceSessionId;
  readonly paneId: TerminalPaneId;
  readonly active: boolean;
  readonly registry: TerminalRegistry;
  readonly transport: TerminalTransport;
}

/**
 * Hosts one xterm.js instance.
 *
 * The component owns the controller's *lifetime*, not its behaviour: after mount,
 * output, input and resizes all flow through the controller without React
 * re-rendering. That is why this component has no props that change during a
 * terminal's life except `active`.
 *
 * Hidden panes stay mounted. The spec requires that "hidden panes continue running",
 * that "narrowing the window never kills a PTY", and that switching panes does not
 * recreate xterm.js — so visibility is CSS, never conditional mounting. Unmounting
 * would dispose the terminal and lose the scrollback.
 */
export const TerminalPane = ({
  sessionId,
  paneId,
  active,
  registry,
  transport,
}: TerminalPaneProps): React.JSX.Element => {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const controllerRef = useRef<TerminalController | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) {
      return;
    }

    const controller = createTerminalController({
      sessionId,
      paneId,
      transport,
      theme: readTerminalTheme(),
      fontFamily: readTerminalFontFamily(),
    });
    controllerRef.current = controller;
    controller.attach(host);

    // Registered after attaching, so the replay of anything buffered before mount
    // lands in a terminal that can render it.
    registry.register(paneId, controller);

    // The element has no size on the frame it is created, so fitting is driven by
    // the observer rather than done once here.
    const observer = new ResizeObserver(() => {
      controller.fit();
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      registry.unregister(paneId);
      controller.dispose();
      controllerRef.current = null;
    };
    // Intentionally keyed only on identity. `registry` and `transport` are stable
    // singletons created outside React; including them would tear down a live
    // terminal if either were ever reallocated.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, paneId]);

  useEffect(() => {
    if (active) {
      // Refit on becoming visible: a pane hidden with `display: none` reports zero
      // size, so its grid is stale by the time it comes back.
      controllerRef.current?.fit();
      controllerRef.current?.focus();
    }
  }, [active]);

  return (
    <div
      ref={hostRef}
      className="terminal-pane"
      data-testid={`terminal-pane-${paneId}`}
      data-active={active}
      hidden={!active}
    />
  );
};
