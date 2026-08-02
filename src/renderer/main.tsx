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

/*
 * Settings are requested before React mounts rather than from an effect inside a component.
 *
 * The round trip is still asynchronous, so this does not make them available to the first render;
 * what it does is start the request at the earliest possible moment and keep it out of the
 * component tree. In practice the values are in place well before they are visible, because the
 * only thing that reads the arrangement is the workspace shell, and that does not exist until the
 * user has opened a folder.
 */
store.dispatch({ type: 'settings/loadRequested' });

const mount = (): void => {
  createRoot(container).render(
    <StrictMode>
      <StoreProvider store={store}>
        <App registry={registry} transport={bridge.terminal} />
      </StoreProvider>
    </StrictMode>,
  );
};

/*
 * React waits for the vendored faces before it mounts, which is not the usual advice and is not
 * about avoiding a flash of the fallback.
 *
 * xterm.js measures a character once, when a Terminal is constructed, and that measurement becomes
 * the pane's grid for as long as it lives. Mount while Iosevka is still arriving and the first
 * terminal measures Consolas, then draws Iosevka into cells sized for something else — every row
 * bent, and no event afterwards to correct it. The window is already on screen by now, painted in
 * --azir-bg by `backgroundColor` in main/windows/mainWindow.ts, so what this costs is a few
 * milliseconds of an empty dark window rather than a white flash.
 *
 * The timeout is not there to make it faster. `document.fonts.ready` settles whether the faces
 * load or fail, so reaching the deadline means something pathological happened — and rendering in
 * the fallback stack is a far better answer to that than a window that never appears.
 */
const FONT_DEADLINE_MS = 2000;

void Promise.race([
  document.fonts.ready,
  new Promise((resolve) => setTimeout(resolve, FONT_DEADLINE_MS)),
]).then(mount);
