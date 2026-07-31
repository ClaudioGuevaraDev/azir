import { describe, expect, it } from 'vitest';
import { ARRANGEMENTS, type Arrangement } from '@shared/models/layout';
import { computeLayout, MIN_SLOT_HEIGHT, MIN_SLOT_WIDTH, type Layout, type Rect } from './engine';

/**
 * The engine is a pure function, which is the whole reason it exists as one: the failure
 * modes here — a negative width, two rects overlapping, a panel that vanishes — are silent
 * in a running app and obvious in a table test.
 */

const layoutAt = (
  width: number,
  height: number,
  arrangement: Arrangement,
  focusedSlot = 0,
): Layout => computeLayout({ width, height, arrangement, focusedSlot });

const rectsOf = (layout: Layout): Rect[] =>
  layout.visibleSlots.map((slot) => layout.rects.get(slot)).filter((rect): rect is Rect => !!rect);

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** A spread of sizes, from absurdly small to a large monitor. */
const SIZES: Array<[number, number]> = [
  [0, 0],
  [1, 1],
  [120, 80],
  [300, 200],
  [480, 320],
  [640, 400],
  [800, 600],
  [1024, 768],
  [1280, 800],
  [1440, 900],
  [1920, 1080],
  [3440, 1440],
  [700, 1200],
  [1200, 300],
];

describe('invariants at every size and arrangement', () => {
  const cases = ARRANGEMENTS.flatMap((arrangement) =>
    SIZES.flatMap(([width, height]) =>
      [0, 1, 2].map((focusedSlot) => ({ arrangement, width, height, focusedSlot })),
    ),
  );

  it('never returns a negative or fractional dimension', () => {
    for (const testCase of cases) {
      const layout = layoutAt(
        testCase.width,
        testCase.height,
        testCase.arrangement,
        testCase.focusedSlot,
      );
      for (const rect of rectsOf(layout)) {
        expect(rect.width).toBeGreaterThanOrEqual(0);
        expect(rect.height).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(rect.x)).toBe(true);
        expect(Number.isFinite(rect.y)).toBe(true);
      }
    }
  });

  it('never overlaps two panels', () => {
    // An overlap shows up as a panel that cannot be clicked, which is the kind of bug
    // nobody reports precisely.
    for (const testCase of cases) {
      const rects = rectsOf(
        layoutAt(testCase.width, testCase.height, testCase.arrangement, testCase.focusedSlot),
      );
      for (let i = 0; i < rects.length; i += 1) {
        for (let j = i + 1; j < rects.length; j += 1) {
          const a = rects[i];
          const b = rects[j];
          if (a && b && a.width > 0 && a.height > 0 && b.width > 0 && b.height > 0) {
            expect(overlaps(a, b)).toBe(false);
          }
        }
      }
    }
  });

  it('never places a panel outside the window', () => {
    for (const testCase of cases) {
      const layout = layoutAt(
        testCase.width,
        testCase.height,
        testCase.arrangement,
        testCase.focusedSlot,
      );
      for (const rect of rectsOf(layout)) {
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width).toBeLessThanOrEqual(testCase.width);
        expect(rect.y + rect.height).toBeLessThanOrEqual(testCase.height);
      }
    }
  });

  it('always returns at least one visible slot', () => {
    // "Small windows produce a useful reduced layout, never an exception."
    for (const testCase of cases) {
      const layout = layoutAt(
        testCase.width,
        testCase.height,
        testCase.arrangement,
        testCase.focusedSlot,
      );
      expect(layout.visibleSlots.length).toBeGreaterThanOrEqual(1);
      expect(layout.rects.size).toBe(layout.visibleSlots.length);
    }
  });

  it('always keeps the focused slot visible', () => {
    for (const testCase of cases) {
      const layout = layoutAt(
        testCase.width,
        testCase.height,
        testCase.arrangement,
        testCase.focusedSlot,
      );
      expect(layout.visibleSlots).toContain(testCase.focusedSlot);
    }
  });

  it('never leaves a visible panel below the usable minimum unless it is the last resort', () => {
    for (const testCase of cases) {
      const layout = layoutAt(
        testCase.width,
        testCase.height,
        testCase.arrangement,
        testCase.focusedSlot,
      );
      if (layout.visibleSlots.length === 1) {
        continue;
      }
      for (const rect of rectsOf(layout)) {
        expect(rect.width).toBeGreaterThanOrEqual(MIN_SLOT_WIDTH);
        expect(rect.height).toBeGreaterThanOrEqual(MIN_SLOT_HEIGHT);
      }
    }
  });
});

describe('tiling', () => {
  it('columns fill the width exactly, with no gap between them', () => {
    const rects = rectsOf(layoutAt(1000, 600, 'columns'));

    expect(rects).toHaveLength(3);
    expect(rects.reduce((sum, rect) => sum + rect.width, 0)).toBe(1000);
    // A one-pixel rounding gap is visible as a hairline seam.
    expect(rects[0]!.x + rects[0]!.width).toBe(rects[1]!.x);
    expect(rects[1]!.x + rects[1]!.width).toBe(rects[2]!.x);
  });

  it('rows fill the height exactly', () => {
    const rects = rectsOf(layoutAt(900, 700, 'rows'));

    expect(rects).toHaveLength(3);
    expect(rects.reduce((sum, rect) => sum + rect.height, 0)).toBe(700);
  });

  it('two-over-one puts slots 0 and 1 above a full-width slot 2', () => {
    const layout = layoutAt(1000, 600, 'two-over-one');
    const first = layout.rects.get(0)!;
    const second = layout.rects.get(1)!;
    const third = layout.rects.get(2)!;

    expect(first.y).toBe(second.y);
    expect(first.height).toBe(second.height);
    expect(third.width).toBe(1000);
    expect(third.y).toBe(first.height);
  });

  it('sidebar-and-stack gives the sidebar a bounded share rather than a third', () => {
    // The tree is an index, not a reading surface; a third of a wide monitor is wasted on
    // it and taken away from the viewer.
    const layout = layoutAt(2000, 900, 'sidebar-and-stack');
    const sidebar = layout.rects.get(0)!;

    expect(sidebar.height).toBe(900);
    expect(sidebar.width).toBeLessThanOrEqual(320);
    expect(sidebar.width).toBeGreaterThanOrEqual(MIN_SLOT_WIDTH);
  });

  it('sidebar-and-stack stacks slots 1 and 2 beside the sidebar', () => {
    const layout = layoutAt(1400, 800, 'sidebar-and-stack');
    const sidebar = layout.rects.get(0)!;
    const upper = layout.rects.get(1)!;
    const lower = layout.rects.get(2)!;

    expect(upper.x).toBe(sidebar.width);
    expect(lower.x).toBe(sidebar.width);
    expect(upper.y + upper.height).toBe(lower.y);
    expect(upper.height + lower.height).toBe(800);
  });
});

describe('degradation', () => {
  it('shows all three panels when there is room', () => {
    const layout = layoutAt(1440, 900, 'columns');

    expect(layout.visibleSlots).toEqual([0, 1, 2]);
    expect(layout.degraded).toBe(false);
  });

  it('falls back to two panels when three will not fit', () => {
    // Three columns need 3 × 220; two need 2 × 220.
    const layout = layoutAt(600, 600, 'columns', 0);

    expect(layout.visibleSlots).toHaveLength(2);
    expect(layout.degraded).toBe(true);
  });

  it('falls back to the focused panel alone when two will not fit', () => {
    const layout = layoutAt(300, 600, 'columns', 1);

    expect(layout.visibleSlots).toEqual([1]);
    expect(layout.rects.get(1)).toEqual({ x: 0, y: 0, width: 300, height: 600 });
  });

  it('degrades on height as well as width', () => {
    const layout = layoutAt(1400, 200, 'rows', 2);

    expect(layout.visibleSlots).toHaveLength(1);
    expect(layout.visibleSlots).toContain(2);
  });

  it('keeps the focused slot and the one cyclically after it', () => {
    // Deterministic, and it cannot prefer a particular panel because the engine does not
    // know which slot holds which.
    expect(layoutAt(600, 600, 'columns', 0).visibleSlots).toEqual([0, 1]);
    expect(layoutAt(600, 600, 'columns', 1).visibleSlots).toEqual([1, 2]);
    expect(layoutAt(600, 600, 'columns', 2).visibleSlots).toEqual([0, 2]);
  });

  it('is stable: the same input always gives the same layout', () => {
    const first = layoutAt(777, 543, 'two-over-one', 1);
    const second = layoutAt(777, 543, 'two-over-one', 1);

    expect([...first.rects.entries()]).toEqual([...second.rects.entries()]);
  });
});

describe('degenerate input', () => {
  it('survives a zero-sized window', () => {
    const layout = layoutAt(0, 0, 'columns');

    expect(layout.visibleSlots).toHaveLength(1);
    expect(layout.rects.get(0)).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });

  it('floors fractional geometry, since a device pixel ratio produces fractions', () => {
    const layout = computeLayout({
      width: 1439.6,
      height: 899.4,
      arrangement: 'columns',
      focusedSlot: 0,
    });

    for (const rect of rectsOf(layout)) {
      expect(Number.isInteger(rect.width)).toBe(true);
      expect(Number.isInteger(rect.height)).toBe(true);
    }
  });

  it('normalises an out-of-range focused slot instead of losing the panel', () => {
    expect(layoutAt(300, 300, 'columns', 7).visibleSlots).toEqual([1]);
    expect(layoutAt(300, 300, 'columns', -1).visibleSlots).toEqual([2]);
  });
});
