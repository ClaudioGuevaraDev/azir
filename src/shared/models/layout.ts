/**
 * Workspace layout, as data.
 *
 * Lives in `shared` rather than the renderer because M8 persists it: settings are loaded
 * by the main process at startup and validated before the renderer sees them, so the
 * types have to be visible to both.
 */

export const PANELS = ['repository', 'viewer', 'terminal'] as const;

export type Panel = (typeof PANELS)[number];

/**
 * How the three slots are arranged.
 *
 * docs/architecture.md keeps panel *order* and *arrangement* as separate settings, which
 * is what lets the layout engine stay ignorant of which panel sits in which slot.
 */
export const ARRANGEMENTS = ['columns', 'rows', 'two-over-one', 'sidebar-and-stack'] as const;

export type Arrangement = (typeof ARRANGEMENTS)[number];

export interface LayoutSettings {
  /** Which panel occupies slot 0, 1 and 2. */
  readonly order: readonly [Panel, Panel, Panel];
  readonly arrangement: Arrangement;
}

/**
 * The default is `sidebar-and-stack` with the tree first: a narrow index on the left, the
 * viewer taking the space it needs to be readable, and the terminal beneath it where its
 * output lines up with the file above. That is the arrangement the supervision loop
 * actually uses.
 */
export const defaultLayoutSettings: LayoutSettings = {
  order: ['repository', 'viewer', 'terminal'],
  arrangement: 'sidebar-and-stack',
};

export const isPanel = (value: unknown): value is Panel =>
  typeof value === 'string' && (PANELS as readonly string[]).includes(value);

export const isArrangement = (value: unknown): value is Arrangement =>
  typeof value === 'string' && (ARRANGEMENTS as readonly string[]).includes(value);
