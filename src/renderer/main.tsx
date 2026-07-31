import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { StoreProvider } from './app/react';
import { createEffectRunner } from './app/runtime/effectRunner';
import { createStore } from './app/store';
import './ui/global.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('index.html is missing #root');
}

// The store is created once, outside React, and wired to the bridge here. This is
// the single place the renderer touches `window.azir`; everything else goes
// through actions and effects.
const store = createStore({
  runEffect: createEffectRunner(window.azir),
});

createRoot(container).render(
  <StrictMode>
    <StoreProvider store={store}>
      <App />
    </StoreProvider>
  </StrictMode>,
);
