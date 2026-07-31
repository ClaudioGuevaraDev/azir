import { useEffect, useRef } from 'react';
import { ARRANGEMENTS, PANELS, type Arrangement, type Panel } from '@shared/models/layout';
import { CODE_FONT_SIZE_RANGE, SHELL_KINDS, type ShellKind } from '@shared/models/settings';
import { reloadRequested } from '../app/actions';
import type { ConfirmIntent, Overlay } from '../app/chrome';
import { useAppState, useDispatch } from '../app/react';
import { documentedBindings } from '../app/runtime/keybindings';
import { selectLayout, selectOverlay, selectSessionId, selectSettings } from '../app/state';
import './OverlayHost.css';

const TITLES: Record<Overlay['type'], string> = {
  help: 'Keyboard shortcuts',
  settings: 'Settings',
  confirm: 'Unsaved changes',
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
      // Clicking outside dismisses — except for a confirmation, where dismissing by accident
      // would be indistinguishable from answering it.
      onClick={() => {
        if (overlay.type !== 'confirm') {
          dispatch({ type: 'overlay/closed' });
        }
      }}
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

        {overlay.type === 'help' && <HelpBody />}
        {overlay.type === 'settings' && <SettingsBody />}
        {overlay.type === 'confirm' && <ConfirmBody intent={overlay.intent} />}
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

/**
 * The confirmation.
 *
 * The destructive choice is never the default and never the primary button: this dialog only
 * ever appears when the alternative is losing work the user did not save. It also names the
 * files, because "you have unsaved changes" with no list is not enough information to answer.
 */
const ConfirmBody = ({ intent }: { readonly intent: ConfirmIntent }): React.JSX.Element => {
  const dispatch = useDispatch();
  const sessionId = useAppState(selectSessionId);

  const body = ((): { message: string; confirmLabel: string; onConfirm: () => void } => {
    switch (intent.kind) {
      case 'discardChanges':
        return {
          message: `${intent.path} has unsaved changes.`,
          confirmLabel: 'Discard and close',
          onConfirm: () => dispatch({ type: 'viewer/closed', path: intent.path }),
        };
      case 'reloadFromDisk':
        return {
          message: `${intent.path} changed on disk and has unsaved changes here.`,
          confirmLabel: 'Discard mine and reload',
          onConfirm: () => {
            if (sessionId !== null) {
              dispatch(reloadRequested(sessionId, intent.path));
            }
          },
        };
      case 'quitWithUnsaved':
        return {
          message:
            intent.paths.length === 1
              ? `${intent.paths[0]} has unsaved changes.`
              : `${intent.paths.length} files have unsaved changes:\n${intent.paths.join('\n')}`,
          confirmLabel: 'Quit without saving',
          onConfirm: () => dispatch({ type: 'app/quitConfirmed' }),
        };
    }
  })();

  return (
    <div className="overlay__confirm" data-testid="confirm-body">
      <p className="overlay__confirm-message">{body.message}</p>
      <div className="overlay__confirm-actions">
        <button
          type="button"
          className="overlay__choice"
          data-active="true"
          data-testid="confirm-cancel"
          onClick={() => dispatch({ type: 'overlay/closed' })}
        >
          Keep editing
        </button>
        <button
          type="button"
          className="overlay__choice overlay__choice--danger"
          data-testid="confirm-accept"
          onClick={body.onConfirm}
        >
          {body.confirmLabel}
        </button>
      </div>
    </div>
  );
};

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

const SHELL_LABELS: Record<ShellKind, string> = {
  default: 'Platform default',
  powershell: 'PowerShell',
  pwsh: 'PowerShell 7',
  cmd: 'Command Prompt',
  bash: 'Bash',
  zsh: 'Zsh',
};

const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, index) => from + index);

const SettingsBody = (): React.JSX.Element => {
  const layout = useAppState(selectLayout);
  const settings = useAppState(selectSettings);
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

      <section className="overlay__group">
        <h3 className="overlay__group-title">Shell</h3>
        <div className="overlay__choices">
          {SHELL_KINDS.map((shell) => (
            <button
              key={shell}
              type="button"
              className="overlay__choice"
              data-active={settings.terminal.shell === shell}
              data-testid={`setting-shell-${shell}`}
              onClick={() => dispatch({ type: 'settings/shellChanged', shell })}
            >
              {SHELL_LABELS[shell]}
            </button>
          ))}
        </div>
        {/*
          Said out loud rather than left to be discovered. There is no way to change a running
          process's executable, so panes that are already open keep the shell they started with —
          a user who picks a new shell and sees the current pane unchanged would otherwise
          reasonably conclude the setting does not work.
        */}
        <p className="overlay__note">Applies to terminal panes opened from now on.</p>
      </section>

      <section className="overlay__group">
        <h3 className="overlay__group-title">Tab width</h3>
        <div className="overlay__choices">
          {[2, 4, 8].map((tabWidth) => (
            <button
              key={tabWidth}
              type="button"
              className="overlay__choice"
              data-active={settings.editor.tabWidth === tabWidth}
              data-testid={`setting-tab-width-${tabWidth}`}
              onClick={() => dispatch({ type: 'settings/tabWidthChanged', tabWidth })}
            >
              {tabWidth} spaces
            </button>
          ))}
        </div>
      </section>

      <section className="overlay__group">
        <h3 className="overlay__group-title">Code font size</h3>
        <div className="overlay__choices">
          {range(CODE_FONT_SIZE_RANGE.min, CODE_FONT_SIZE_RANGE.max)
            .filter((size) => size % 2 === 0)
            .map((codeFontSize) => (
              <button
                key={codeFontSize}
                type="button"
                className="overlay__choice"
                data-active={settings.appearance.codeFontSize === codeFontSize}
                data-testid={`setting-font-size-${codeFontSize}`}
                onClick={() => dispatch({ type: 'settings/codeFontSizeChanged', codeFontSize })}
              >
                {codeFontSize}
              </button>
            ))}
        </div>
      </section>

      {settings.invalidFields.length > 0 && (
        <p className="overlay__note" data-warning data-testid="settings-invalid">
          {/*
            The settings file had values Azir could not use, and they were reset one field at a
            time. Naming them is the difference between "my edit did nothing" and "my edit was
            wrong" — without this the fallback is indistinguishable from the application ignoring
            the user.
          */}
          Reset to defaults because the settings file could not be read:{' '}
          {settings.invalidFields.join(', ')}.
        </p>
      )}
    </div>
  );
};
