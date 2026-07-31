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
 */
export const WelcomeScreen = ({ busy, error }: WelcomeScreenProps): React.JSX.Element => {
  const dispatch = useDispatch();

  return (
    <main className="welcome" data-testid="welcome">
      <div className="welcome__card">
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

        {error && (
          <p className="welcome__error" role="alert" data-testid="welcome-error">
            {error.message}
          </p>
        )}
      </div>
    </main>
  );
};
