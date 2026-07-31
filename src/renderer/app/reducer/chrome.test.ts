import { describe, expect, it } from 'vitest';
import type { Action } from '../actions';
import {
  initialFocusState,
  initialLayoutState,
  initialOverlayState,
  panelInSlot,
  slotOf,
  type FocusState,
  type LayoutState,
  type OverlayState,
} from '../chrome';
import { focusReducer, layoutReducer, overlayReducer } from './chrome';

const runLayout = (state: LayoutState, ...actions: Action[]): LayoutState =>
  actions.reduce((current, action) => layoutReducer(current, action).state, state);

const runFocus = (state: FocusState, ...actions: Action[]): FocusState =>
  actions.reduce((current, action) => focusReducer(current, action).state, state);

const runOverlay = (state: OverlayState, ...actions: Action[]): OverlayState =>
  actions.reduce((current, action) => overlayReducer(current, action).state, state);

describe('layout geometry', () => {
  it('records the measured size', () => {
    const result = runLayout(initialLayoutState, {
      type: 'layout/resized',
      width: 1440,
      height: 800,
    });

    expect(result).toMatchObject({ width: 1440, height: 800 });
  });

  it('preserves identity when the size did not change', () => {
    // A ResizeObserver fires on every frame of a window drag; allocating a new state for
    // each identical measurement would notify every subscriber for nothing.
    const sized = runLayout(initialLayoutState, {
      type: 'layout/resized',
      width: 1440,
      height: 800,
    });

    expect(layoutReducer(sized, { type: 'layout/resized', width: 1440, height: 800 }).state).toBe(
      sized,
    );
  });

  it('stores no derived rectangles', () => {
    // The rects come from the pure engine. Putting them in state would mean writing three
    // objects instead of two numbers on every frame of a drag.
    const result = runLayout(initialLayoutState, {
      type: 'layout/resized',
      width: 900,
      height: 600,
    });

    expect(Object.keys(result).sort()).toEqual(['height', 'settings', 'width']);
  });
});

describe('layout settings', () => {
  it('changes the arrangement', () => {
    const result = runLayout(initialLayoutState, {
      type: 'layout/arrangementChanged',
      arrangement: 'columns',
    });

    expect(result.settings.arrangement).toBe('columns');
  });

  it('preserves identity when the arrangement is unchanged', () => {
    expect(
      layoutReducer(initialLayoutState, {
        type: 'layout/arrangementChanged',
        arrangement: initialLayoutState.settings.arrangement,
      }).state,
    ).toBe(initialLayoutState);
  });

  it('changes the panel order', () => {
    const result = runLayout(initialLayoutState, {
      type: 'layout/orderChanged',
      order: ['terminal', 'viewer', 'repository'],
    });

    expect(result.settings.order).toEqual(['terminal', 'viewer', 'repository']);
  });

  it('preserves identity when the order is unchanged', () => {
    expect(
      layoutReducer(initialLayoutState, {
        type: 'layout/orderChanged',
        order: [...initialLayoutState.settings.order] as ['repository', 'viewer', 'terminal'],
      }).state,
    ).toBe(initialLayoutState);
  });

  it('keeps the arrangement across closing a workspace, because it is a preference', () => {
    const configured = runLayout(
      initialLayoutState,
      { type: 'layout/arrangementChanged', arrangement: 'rows' },
      { type: 'layout/resized', width: 1000, height: 700 },
    );

    const result = runLayout(configured, { type: 'workspace/closed', sessionId: 1 });

    expect(result.settings.arrangement).toBe('rows');
    // Only the measurement resets, because the panel area unmounts.
    expect(result).toMatchObject({ width: 0, height: 0 });
  });
});

describe('slot mapping', () => {
  it('resolves a panel to its slot and back', () => {
    const settings = {
      order: ['terminal', 'repository', 'viewer'] as const,
      arrangement: 'columns' as const,
    };

    expect(slotOf(settings, 'terminal')).toBe(0);
    expect(slotOf(settings, 'viewer')).toBe(2);
    expect(panelInSlot(settings, 1)).toBe('repository');
  });

  it('reports nothing for a slot that does not exist', () => {
    expect(panelInSlot(initialLayoutState.settings, 5)).toBeUndefined();
  });
});

describe('focus', () => {
  it('starts on the terminal, where keystrokes have a consequence', () => {
    expect(initialFocusState.panel).toBe('terminal');
  });

  it('moves', () => {
    expect(runFocus(initialFocusState, { type: 'focus/changed', panel: 'viewer' }).panel).toBe(
      'viewer',
    );
  });

  it('preserves identity when focus did not move', () => {
    // Focus is set on every mousedown, including repeated clicks in the same panel.
    expect(
      focusReducer(initialFocusState, { type: 'focus/changed', panel: 'terminal' }).state,
    ).toBe(initialFocusState);
  });

  it('resets when the workspace closes', () => {
    const moved = runFocus(initialFocusState, { type: 'focus/changed', panel: 'repository' });

    expect(focusReducer(moved, { type: 'workspace/closed', sessionId: 1 }).state).toBe(
      initialFocusState,
    );
  });
});

describe('overlays', () => {
  it('opens one', () => {
    const result = runOverlay(initialOverlayState, {
      type: 'overlay/opened',
      overlay: { type: 'help' },
    });

    expect(result.current).toEqual({ type: 'help' });
  });

  it('holds at most one, so only one thing can own the keyboard', () => {
    // Modelled as a single value rather than a stack, which makes the spec's "only one modal
    // overlay should own keyboard input" structural instead of a rule to remember.
    const result = runOverlay(
      initialOverlayState,
      { type: 'overlay/opened', overlay: { type: 'help' } },
      { type: 'overlay/opened', overlay: { type: 'settings' } },
    );

    expect(result.current).toEqual({ type: 'settings' });
  });

  it('preserves identity when reopening the same overlay', () => {
    const open = runOverlay(initialOverlayState, {
      type: 'overlay/opened',
      overlay: { type: 'help' },
    });

    expect(overlayReducer(open, { type: 'overlay/opened', overlay: { type: 'help' } }).state).toBe(
      open,
    );
  });

  it('closes', () => {
    const closed = runOverlay(
      initialOverlayState,
      { type: 'overlay/opened', overlay: { type: 'settings' } },
      { type: 'overlay/closed' },
    );

    expect(closed).toBe(initialOverlayState);
  });

  it('ignores a close when nothing is open', () => {
    expect(overlayReducer(initialOverlayState, { type: 'overlay/closed' }).state).toBe(
      initialOverlayState,
    );
  });

  it('closes when the workspace goes away', () => {
    // An overlay describing a workspace that no longer exists has nothing to say.
    const open = runOverlay(initialOverlayState, {
      type: 'overlay/opened',
      overlay: { type: 'settings' },
    });

    expect(overlayReducer(open, { type: 'workspace/closed', sessionId: 1 }).state).toBe(
      initialOverlayState,
    );
  });

  it('requests no work, because an overlay is pure UI state', () => {
    const result = overlayReducer(initialOverlayState, {
      type: 'overlay/opened',
      overlay: { type: 'help' },
    });

    expect(result.effects).toEqual([]);
  });
});
