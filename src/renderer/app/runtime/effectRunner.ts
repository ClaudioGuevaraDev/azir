import type { AppBridge } from '@shared/bridge';
import { pathChosen } from '../actions';
import type { Effect } from '../effects';
import type { Dispatch, EffectRunner } from '../store';

/**
 * Turns effects into bridge calls, and bridge results back into actions.
 *
 * This is the only place in the renderer that touches `window.azir`, and the only
 * place a `Result` is unwrapped. Everything downstream sees actions carrying
 * facts.
 *
 * It takes the bridge as an argument rather than reading the global, which is
 * what makes it testable with a fake — and what keeps it honest about being the
 * boundary.
 */
export const createEffectRunner = (bridge: AppBridge): EffectRunner => {
  const run = async (effect: Effect, dispatch: Dispatch): Promise<void> => {
    switch (effect.type) {
      case 'workspace/pickFolder': {
        const result = await bridge.workspace.pickFolder();
        if (!result.ok) {
          dispatch({ type: 'workspace/pickFailed', error: result.error });
          return;
        }
        if (result.value === null) {
          dispatch({ type: 'workspace/pickCancelled' });
          return;
        }
        // `pathChosen` mints the request id here, at the dispatch edge, because
        // the reducer must stay pure.
        dispatch(pathChosen(result.value));
        return;
      }

      case 'workspace/open': {
        const result = await bridge.workspace.open({ path: effect.path });
        if (!result.ok) {
          dispatch({
            type: 'workspace/openFailed',
            requestId: effect.requestId,
            error: result.error,
          });
          return;
        }
        dispatch({ type: 'workspace/opened', requestId: effect.requestId, info: result.value });
        return;
      }

      case 'repository/listDirectory': {
        const result = await bridge.files.listDirectory({
          sessionId: effect.sessionId,
          path: effect.path,
        });
        if (!result.ok) {
          dispatch({
            type: 'repository/directoryFailed',
            sessionId: effect.sessionId,
            path: effect.path,
            requestId: effect.requestId,
            error: result.error,
          });
          return;
        }
        dispatch({
          type: 'repository/directoryLoaded',
          sessionId: effect.sessionId,
          path: effect.path,
          requestId: effect.requestId,
          entries: result.value.entries,
        });
        return;
      }

      case 'terminal/create': {
        const result = await bridge.terminal.create({
          sessionId: effect.sessionId,
          paneId: effect.paneId,
          shell: 'default',
        });
        if (!result.ok) {
          dispatch({
            type: 'terminal/createFailed',
            sessionId: effect.sessionId,
            paneId: effect.paneId,
            error: result.error,
          });
          return;
        }
        dispatch({
          type: 'terminal/created',
          sessionId: effect.sessionId,
          paneId: effect.paneId,
          shellPath: result.value.shellPath,
          cwd: result.value.cwd,
        });
        return;
      }

      case 'terminal/kill': {
        // Fire-and-forget: the reducer has already removed the pane, and there is
        // no outcome worth waiting for. Main's kill is idempotent.
        bridge.terminal.kill({ sessionId: effect.sessionId, paneId: effect.paneId });
        return;
      }

      case 'workspace/close': {
        const result = await bridge.workspace.close({ sessionId: effect.sessionId });
        if (!result.ok) {
          // The workspace is already gone from the renderer's point of view; a
          // failure to tear down in main is worth surfacing but must not block.
          dispatch({
            type: 'notice/raised',
            severity: 'warning',
            message: 'The workspace did not shut down cleanly.',
            ...(result.error.detail === undefined ? {} : { detail: result.error.detail }),
          });
          return;
        }
        dispatch({ type: 'workspace/closed', sessionId: effect.sessionId });
        return;
      }
    }
  };

  return (effect, dispatch) => {
    // The store's contract is that running an effect never throws and never
    // returns a promise it expects anyone to await. A bug inside an effect
    // becomes a notice, not an unhandled rejection.
    void run(effect, dispatch).catch((error: unknown) => {
      console.error('[effects] runner failed:', effect, error);
      dispatch({
        type: 'notice/raised',
        severity: 'error',
        message: 'An internal action failed.',
        detail: error instanceof Error ? error.message : String(error),
      });
    });
  };
};
