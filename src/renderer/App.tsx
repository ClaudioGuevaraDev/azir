import { useEffect, useState } from 'react';
import type { PingResponse } from '@shared/ipc/contracts';
import './App.css';

type BridgeCheck =
  | { status: 'checking' }
  | { status: 'ready'; value: PingResponse }
  | { status: 'error'; message: string };

/**
 * M0 shell. Its only job is to prove the boundary works end to end: a nonce
 * minted here travels renderer → preload → main and comes back alongside the
 * versions only the main process can know. Milestone 1 replaces this with the
 * real workspace shell driven by the reducer.
 */
export const App = (): React.JSX.Element => {
  const [check, setCheck] = useState<BridgeCheck>({ status: 'checking' });

  useEffect(() => {
    let cancelled = false;
    const nonce = `m0-${Math.random().toString(36).slice(2, 10)}`;

    void window.azir.app.ping({ nonce }).then((result) => {
      if (cancelled) {
        return;
      }
      if (!result.ok) {
        setCheck({ status: 'error', message: `${result.error.code}: ${result.error.message}` });
        return;
      }
      if (result.value.nonce !== nonce) {
        setCheck({ status: 'error', message: 'Response nonce did not match the request.' });
        return;
      }
      setCheck({ status: 'ready', value: result.value });
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="welcome">
      <div className="welcome__card">
        <h1 className="welcome__title">Azir</h1>
        <p className="welcome__tagline">Supervision workspace for software agents</p>

        <div className="welcome__status" data-testid="bridge-status" data-state={check.status}>
          {check.status === 'checking' && <span className="welcome__dim">Checking bridge…</span>}

          {check.status === 'error' && <span className="welcome__error">{check.message}</span>}

          {check.status === 'ready' && (
            <dl className="welcome__versions">
              <div>
                <dt>Electron</dt>
                <dd className="azir-selectable">{check.value.electron}</dd>
              </div>
              <div>
                <dt>Chromium</dt>
                <dd className="azir-selectable">{check.value.chrome}</dd>
              </div>
              <div>
                <dt>Node</dt>
                <dd className="azir-selectable">{check.value.node}</dd>
              </div>
              <div>
                <dt>Platform</dt>
                <dd className="azir-selectable">{check.value.platform}</dd>
              </div>
            </dl>
          )}
        </div>
      </div>
    </main>
  );
};
