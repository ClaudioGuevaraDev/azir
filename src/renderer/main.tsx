import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { StoreProvider } from './app/react';
import { createEffectRunner } from './app/runtime/effectRunner';
import { startEventPump } from './app/runtime/eventPump';
import { createStore } from './app/store';
import { selectActivePaneId } from './app/state';
import { createTerminalRegistry } from './terminal/registry';
// xterm's own stylesheet first, so ui/global.css can override it.
import '@xterm/xterm/css/xterm.css';
import './ui/global.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('index.html is missing #root');
}

const bridge = window.azir;

// Everything below is created once, outside React. This is the only place in the
// renderer that touches `window.azir`; the store reaches it through the effect
// runner, and the terminal controllers through the transport.
const registry = createTerminalRegistry();

const store = createStore({
  runEffect: createEffectRunner(bridge),
});

// Subscribes to main's pushes. Terminal bytes go to the registry and never enter
// the store; discrete facts like a shell exiting are dispatched.
startEventPump({
  bridge,
  registry,
  dispatch: store.dispatch,
  activePaneId: () => selectActivePaneId(store.getState()),
  loadedDirectories: () => Object.keys(store.getState().repository.directories),
  unsavedPaths: () =>
    store
      .getState()
      .viewer.tabs.filter((tab) => tab.dirty)
      .map((tab) => tab.path),
});

createRoot(container).render(
  <StrictMode>
    <StoreProvider store={store}>
      <App registry={registry} transport={bridge.terminal} />
    </StoreProvider>
  </StrictMode>,
);
