/// <reference types="vite/client" />

import type { AppBridge } from '@shared/bridge';

declare global {
  interface Window {
    /**
     * Installed by the preload via contextBridge. This is the renderer's entire
     * view of the operating system — there is deliberately no other route.
     */
    readonly azir: AppBridge;
  }
}
