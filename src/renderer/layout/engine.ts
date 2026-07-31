import type { Arrangement } from '@shared/models/layout';

/**
 * The layout engine.
 *
 * docs/architecture.md is precise about the contract, and the precision is the point:
 * "The layout engine receives slot order and returns rectangles. It must not know which
 * panel occupies each slot." So this module deals in slot indexes and geometry only. The
 * caller maps `order[i]` onto `rects[i]`, which is what makes panel order a setting rather
 * than a rewrite.
 *
 * The other requirement is that reduced window size **degrades** rather than breaking:
 *
 *     full layout → two panels → focused panel only
 *
 * A pure function is what makes that assertable. The failure mode of getting it wrong is
 * a negative width or two overlapping rects — silent, and only visible as a panel that
 * mysteriously cannot be clicked — so the tests check those invariants at many sizes
 * rather than at a few chosen ones.
 */

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface LayoutInput {
  readonly width: number;
  readonly height: number;
  readonly arrangement: Arrangement;
  /**
   * The slot that must stay visible when the layout degrades.
   *
   * "The focused panel remains visible" is a hard requirement: degrading a window by
   * hiding the thing the user is working in would be worse than not degrading at all.
   */
  readonly focusedSlot: number;
}

export interface Layout {
  /** One rect per visible slot, keyed by slot index. Absent slots are hidden. */
  readonly rects: ReadonlyMap<number, Rect>;
  readonly visibleSlots: readonly number[];
  /** True when fewer than three slots are shown because there was no room. */
  readonly degraded: boolean;
}

/**
 * Below these, a panel stops being usable rather than merely cramped: a tree with no room
 * for a filename, a terminal too narrow for a prompt.
 */
export const MIN_SLOT_WIDTH = 220;
export const MIN_SLOT_HEIGHT = 120;

const SLOT_COUNT = 3;

/** Splits a length into `count` parts that sum exactly to it, with no rounding drift. */
const split = (start: number, total: number, count: number): Array<[number, number]> => {
  const parts: Array<[number, number]> = [];
  let consumed = 0;
  for (let index = 0; index < count; index += 1) {
    // The last part takes the remainder, so `Math.round` cannot lose or gain a pixel and
    // leave a one-pixel gap or overlap between panels.
    const size =
      index === count - 1 ? total - consumed : Math.round((total * (index + 1)) / count) - consumed;
    parts.push([start + consumed, size]);
    consumed += size;
  }
  return parts;
};

/**
 * Weighted split for `sidebar-and-stack`: the sidebar is an index, not a reading surface,
 * so it gets a fixed share rather than a third.
 */
const SIDEBAR_FRACTION = 0.24;
const SIDEBAR_MAX = 320;

const columns = (width: number, height: number, count: number): Rect[] =>
  split(0, width, count).map(([x, w]) => ({ x, y: 0, width: w, height }));

const rows = (width: number, height: number, count: number): Rect[] =>
  split(0, height, count).map(([y, h]) => ({ x: 0, y, width, height: h }));

const threeSlotRects = (input: LayoutInput): Rect[] => {
  const { width, height, arrangement } = input;

  switch (arrangement) {
    case 'columns':
      return columns(width, height, SLOT_COUNT);

    case 'rows':
      return rows(width, height, SLOT_COUNT);

    case 'two-over-one': {
      const [top, bottom] = split(0, height, 2);
      const topY = top?.[0] ?? 0;
      const topH = top?.[1] ?? 0;
      const bottomY = bottom?.[0] ?? 0;
      const bottomH = bottom?.[1] ?? 0;
      const [left, right] = split(0, width, 2);
      return [
        { x: left?.[0] ?? 0, y: topY, width: left?.[1] ?? 0, height: topH },
        { x: right?.[0] ?? 0, y: topY, width: right?.[1] ?? 0, height: topH },
        { x: 0, y: bottomY, width, height: bottomH },
      ];
    }

    case 'sidebar-and-stack': {
      const sidebarWidth = Math.min(
        SIDEBAR_MAX,
        Math.max(MIN_SLOT_WIDTH, width * SIDEBAR_FRACTION),
      );
      const rest = width - sidebarWidth;
      const [top, bottom] = split(0, height, 2);
      return [
        { x: 0, y: 0, width: sidebarWidth, height },
        { x: sidebarWidth, y: top?.[0] ?? 0, width: rest, height: top?.[1] ?? 0 },
        { x: sidebarWidth, y: bottom?.[0] ?? 0, width: rest, height: bottom?.[1] ?? 0 },
      ];
    }
  }
};

/** True when every rect is big enough to be usable. */
const allFit = (rects: readonly Rect[]): boolean =>
  rects.every((rect) => rect.width >= MIN_SLOT_WIDTH && rect.height >= MIN_SLOT_HEIGHT);

/**
 * Which two slots survive the first step of degradation.
 *
 * The focused slot plus the one cyclically after it, rendered in ascending order. The rule
 * is arbitrary but it has to be *deterministic* and it has to always include the focused
 * slot — and it cannot prefer, say, "keep the viewer", because the engine is not allowed
 * to know which slot the viewer is.
 */
const twoSlotChoice = (focusedSlot: number): number[] => {
  const focused = ((focusedSlot % SLOT_COUNT) + SLOT_COUNT) % SLOT_COUNT;
  const companion = (focused + 1) % SLOT_COUNT;
  return [focused, companion].sort((a, b) => a - b);
};

/** For two slots, every arrangement collapses onto its dominant axis. */
const twoSlotRects = (input: LayoutInput): Rect[] =>
  input.arrangement === 'rows'
    ? rows(input.width, input.height, 2)
    : columns(input.width, input.height, 2);

export const computeLayout = (input: LayoutInput): Layout => {
  const width = Math.max(0, Math.floor(input.width));
  const height = Math.max(0, Math.floor(input.height));
  const geometry = { ...input, width, height };

  const three = threeSlotRects(geometry);
  if (allFit(three)) {
    return {
      rects: new Map(three.map((rect, index) => [index, rect])),
      visibleSlots: [0, 1, 2],
      degraded: false,
    };
  }

  const pair = twoSlotChoice(geometry.focusedSlot);
  const two = twoSlotRects(geometry);
  if (allFit(two)) {
    return {
      rects: new Map(pair.map((slot, index) => [slot, two[index] ?? two[0]!])),
      visibleSlots: pair,
      degraded: true,
    };
  }

  // Last resort. Never returns nothing: a window too small for even one panel still has to
  // render something, so the focused slot takes whatever there is. "Small windows produce
  // a useful reduced layout, never an exception."
  const focused = ((geometry.focusedSlot % SLOT_COUNT) + SLOT_COUNT) % SLOT_COUNT;
  return {
    rects: new Map([[focused, { x: 0, y: 0, width, height }]]),
    visibleSlots: [focused],
    degraded: true,
  };
};
