import { useDispatch } from '../app/react';
import type { AppError } from '@shared/ipc/result';
import './WelcomeScreen.css';

export interface WelcomeScreenProps {
  readonly busy: boolean;
  readonly error?: AppError;
}

/**
 * Shown while no workspace is open. Dispatches intent and renders state; it
 * neither opens the dialog nor knows that one exists (invariant 3).
 *
 * This is the one screen with nothing to supervise, which is why it is the one screen allowed to
 * be emphatic. Everywhere else the argument holds that a window read all day should stay quiet;
 * here there is no tree, no diff and no output for decoration to compete with, and the alternative
 * to saying something is a grey rectangle with a button in it.
 */
export const WelcomeScreen = ({ busy, error }: WelcomeScreenProps): React.JSX.Element => {
  const dispatch = useDispatch();

  return (
    <main className="welcome" data-testid="welcome">
      {/* Inert, and behind everything: the instrument grid and the horizon it fades into. */}
      <div className="welcome__field" aria-hidden="true" />

      <div className="welcome__content">
        <h1 className="welcome__title">Azir</h1>
        <p className="welcome__tagline">Supervision workspace for software agents</p>

        <button
          type="button"
          className="welcome__action"
          disabled={busy}
          data-testid="open-workspace"
          onClick={() => dispatch({ type: 'workspace/openRequested' })}
        >
          {busy ? 'Opening…' : 'Open folder…'}
        </button>

        <p className="welcome__hint" aria-hidden="true">
          no workspace open
        </p>

        {error && (
          <p className="welcome__error" role="alert" data-testid="welcome-error">
            {error.message}
          </p>
        )}
      </div>
    </main>
  );
};
