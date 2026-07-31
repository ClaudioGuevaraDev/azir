import { useEffect, useRef } from 'react';
import { ARRANGEMENTS, PANELS, type Arrangement, type Panel } from '@shared/models/layout';
import type { Overlay } from '../app/chrome';
import { useAppState, useDispatch } from '../app/react';
import { documentedBindings } from '../app/runtime/keybindings';
import { selectLayout, selectOverlay } from '../app/state';
import './OverlayHost.css';

const TITLES: Record<Overlay['type'], string> = {
  help: 'Keyboard shortcuts',
  settings: 'Settings',
};

/**
 * Draws whichever overlay is open, over the workspace.
 *
 * docs/architecture.md: overlays "are drawn over the workspace, do not change panel order,
 * do not occupy permanent layout slots, preserve the focused panel underneath, and restore
 * the previous workspace when closed". All five fall out of rendering here rather than in a
 * layout slot — the panels beneath keep their geometry and their focus, and closing is a
 * single state change.
 *
 * Keyboard ownership is enforced upstream, in `matchBinding`: while an overlay is open,
 * every application shortcut except Escape stops matching.
 */
export const OverlayHost = (): React.JSX.Element | null => {
  const overlay = useAppState(selectOverlay);
  const dispatch = useDispatch();
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    // Focus moves into the overlay so the keyboard genuinely follows it — otherwise Tab
    // would walk the tree behind the modal, and a screen reader would still be reading it.
    if (overlay) {
      panelRef.current?.focus();
    }
  }, [overlay]);

  if (!overlay) {
    return null;
  }

  return (
    <div
      className="overlay"
      data-testid="overlay"
      data-overlay={overlay.type}
      // Clicking outside dismisses, which is what a modal that owns no data should do.
      onClick={() => dispatch({ type: 'overlay/closed' })}
    >
      <div
        className="overlay__panel"
        role="dialog"
        aria-modal="true"
        aria-label={TITLES[overlay.type]}
        tabIndex={-1}
        ref={panelRef}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="overlay__header">
          <h2 className="overlay__title">{TITLES[overlay.type]}</h2>
          <button
            type="button"
            className="overlay__close"
            aria-label="Close"
            data-testid="overlay-close"
            onClick={() => dispatch({ type: 'overlay/closed' })}
          >
            ×
          </button>
        </header>

        {overlay.type === 'help' ? <HelpBody /> : <SettingsBody />}
      </div>
    </div>
  );
};

const HelpBody = (): React.JSX.Element => (
  <dl className="overlay__shortcuts" data-testid="help-shortcuts">
    {documentedBindings().map((binding) => (
      <div key={binding.label} className="overlay__shortcut">
        <dt>
          <kbd>{binding.label}</kbd>
        </dt>
        <dd>{binding.description}</dd>
      </div>
    ))}
    <p className="overlay__note">
      Everything else goes to the terminal — including Ctrl+C, Ctrl+D, Ctrl+R, Tab and the arrow
      keys.
    </p>
  </dl>
);

const ARRANGEMENT_LABELS: Record<Arrangement, string> = {
  columns: 'Three columns',
  rows: 'Three rows',
  'two-over-one': 'Two over one',
  'sidebar-and-stack': 'Sidebar and stack',
};

const PANEL_LABELS: Record<Panel, string> = {
  repository: 'Repository',
  viewer: 'Viewer',
  terminal: 'Terminal',
};

const SettingsBody = (): React.JSX.Element => {
  const layout = useAppState(selectLayout);
  const dispatch = useDispatch();

  /**
   * Order is edited by choosing which panel goes in a slot; picking one that already lives
   * elsewhere swaps the two. That keeps the order a permutation by construction — a
   * free-form list would let the user produce `[viewer, viewer, terminal]` and lose a panel.
   */
  const assign = (slot: number, panel: Panel): void => {
    const order = [...layout.settings.order] as [Panel, Panel, Panel];
    const existing = order.indexOf(panel);
    const displaced = order[slot];
    if (existing === -1 || displaced === undefined) {
      return;
    }
    order[existing] = displaced;
    order[slot] = panel;
    dispatch({ type: 'layout/orderChanged', order });
  };

  return (
    <div className="overlay__settings">
      <section className="overlay__group">
        <h3 className="overlay__group-title">Arrangement</h3>
        <div className="overlay__choices">
          {ARRANGEMENTS.map((arrangement) => (
            <button
              key={arrangement}
              type="button"
              className="overlay__choice"
              data-active={layout.settings.arrangement === arrangement}
              data-testid={`setting-arrangement-${arrangement}`}
              onClick={() => dispatch({ type: 'layout/arrangementChanged', arrangement })}
            >
              {ARRANGEMENT_LABELS[arrangement]}
            </button>
          ))}
        </div>
      </section>

      <section className="overlay__group">
        <h3 className="overlay__group-title">Panel order</h3>
        {layout.settings.order.map((panel, slot) => (
          <div key={slot} className="overlay__slot">
            <span className="overlay__slot-label">Slot {slot + 1}</span>
            <div className="overlay__choices">
              {PANELS.map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  className="overlay__choice"
                  data-active={panel === candidate}
                  data-testid={`setting-slot-${slot}-${candidate}`}
                  onClick={() => assign(slot, candidate)}
                >
                  {PANEL_LABELS[candidate]}
                </button>
              ))}
            </div>
          </div>
        ))}
      </section>

      <p className="overlay__note">
        Not persisted yet — settings are written to disk in the next milestone.
      </p>
    </div>
  );
};
