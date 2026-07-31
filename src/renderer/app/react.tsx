import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';
import type { Dispatch, Store } from './store';
import type { AppState } from './state';

/**
 * React bindings over the store.
 *
 * `useSyncExternalStore` rather than Zustand or a custom `useState` bridge: the
 * architecture already specifies a pure reducer as the single writer, so all
 * React needs is a subscription primitive. Adding a state library would add a
 * second writer and contradict invariant 1. It also gets tearing correctness
 * under concurrent rendering for free, which hand-rolled subscriptions do not.
 */

const StoreContext = createContext<Store | null>(null);

export const StoreProvider = ({
  store,
  children,
}: {
  store: Store;
  children: React.ReactNode;
}): React.JSX.Element => <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;

export const useStore = (): Store => {
  const store = useContext(StoreContext);
  if (!store) {
    throw new Error('useStore was called outside a StoreProvider');
  }
  return store;
};

/**
 * Subscribe to a slice of state.
 *
 * The selector must be **referentially stable** — a module-level constant, not an
 * inline arrow. `useSyncExternalStore` compares snapshots by identity, so an
 * inline selector would be a new function every render, and a selector that
 * builds a new object would report a change on every read and loop. Selectors
 * live next to the state in state.ts for this reason; slice reducers preserve
 * identity so that selecting a slice is stable.
 */
export const useAppState = <T,>(select: (state: AppState) => T): T => {
  const store = useStore();
  return useSyncExternalStore(
    store.subscribe,
    useCallback(() => select(store.getState()), [store, select]),
  );
};

export const useDispatch = (): Dispatch => useStore().dispatch;
