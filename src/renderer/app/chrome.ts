import { defaultLayoutSettings, type LayoutSettings, type Panel } from '@shared/models/layout';

/**
 * The workspace chrome: geometry, focus and overlays.
 *
 * Three small slices rather than one, because they change for unrelated reasons. Geometry
 * changes on every window drag, focus on every click, and overlays only when the user asks
 * for one — merging them would make a resize invalidate the overlay's memoisation and vice
 * versa.
 */

export interface LayoutState {
  readonly settings: LayoutSettings;
  /** The panel area's size in CSS pixels, not the window's. */
  readonly width: number;
  readonly height: number;
}

export const initialLayoutState: LayoutState = {
  settings: defaultLayoutSettings,
  width: 0,
  height: 0,
};

export interface FocusState {
  readonly panel: Panel;
}

/**
 * The terminal starts focused.
 *
 * A supervision session usually begins by running something, and it is also the only panel
 * where focus has a mechanical consequence — keystrokes go to a shell. Starting anywhere
 * else would mean the first thing the user types goes nowhere.
 */
export const initialFocusState: FocusState = { panel: 'terminal' };

/**
 * What a confirmation is about.
 *
 * Carried as data rather than a callback so the overlay stays a serialisable projection of
 * state — an overlay holding a closure could not be logged, compared or replayed, and it would
 * let a component smuggle behaviour past the reducer.
 */
export type ConfirmIntent =
  | { readonly kind: 'discardChanges'; readonly path: string }
  | { readonly kind: 'reloadFromDisk'; readonly path: string }
  | { readonly kind: 'quitWithUnsaved'; readonly paths: readonly string[] };

/**
 * Overlays are drawn over the workspace and never occupy a layout slot.
 *
 * The spec's four, all present as of M8.
 */
export type Overlay =
  | { readonly type: 'help' }
  | { readonly type: 'settings' }
  | { readonly type: 'search' }
  | { readonly type: 'confirm'; readonly intent: ConfirmIntent };

export interface OverlayState {
  /**
   * At most one. docs/architecture.md: "Only one modal overlay should own keyboard input at
   * a time." Modelling it as a single value rather than a stack makes that structural
   * instead of a rule someone has to remember.
   */
  readonly current: Overlay | null;
}

export const initialOverlayState: OverlayState = { current: null };

/** Which slot a panel occupies under the current order. */
export const slotOf = (settings: LayoutSettings, panel: Panel): number =>
  settings.order.indexOf(panel);

export const panelInSlot = (settings: LayoutSettings, slot: number): Panel | undefined =>
  settings.order[slot];
