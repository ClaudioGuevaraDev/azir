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
 * Overlays are drawn over the workspace and never occupy a layout slot.
 *
 * `search` and `confirm` from the spec's union are absent until they have callers: search
 * arrives in M8, confirm with editing in M7b.
 */
export type Overlay = { readonly type: 'help' } | { readonly type: 'settings' };

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
