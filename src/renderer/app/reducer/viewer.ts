import { applyEdit, joinForTransport } from '../document';
import type { Effect } from '../effects';
import {
  findTab,
  hasUnsavedWork,
  initialViewerState,
  MAX_TABS,
  newTab,
  toDocument,
  type ViewerState,
  type ViewerTab,
} from '../viewer';
import { changed, idle, withEffects, type Reduction, type SliceReducer } from './combine';

/**
 * The code viewer.
 *
 * The centre of this slice is staleness. docs/architecture.md: "Every async file or diff
 * response carries both `path` and `requestId`. The reducer accepts the response only
 * when it still belongs to the relevant request. This prevents stale responses from
 * replacing newer content."
 *
 * Both halves of that check matter and they catch different bugs. The **path** catches a
 * response for a tab that has since been closed — accepting it would resurrect the tab.
 * The **request id** catches a response for the right tab but the wrong request: click a
 * file, click it again after a watcher reload started, and the slower answer must not
 * win. Neither check alone is enough.
 */

const replaceTab = (
  state: ViewerState,
  path: string,
  update: (tab: ViewerTab) => ViewerTab,
): ViewerState | undefined => {
  const index = state.tabs.findIndex((tab) => tab.path === path);
  if (index === -1) {
    return undefined;
  }
  const existing = state.tabs[index];
  if (!existing) {
    return undefined;
  }
  const next = update(existing);
  if (next === existing) {
    return undefined;
  }
  const tabs = [...state.tabs];
  tabs[index] = next;
  return { ...state, tabs };
};

/** Accepts a content response only if it answers the request that tab is waiting on. */
const contentIsCurrent = (tab: ViewerTab | undefined, requestId: string): boolean =>
  tab !== undefined && tab.contentRequestId === requestId;

const diffIsCurrent = (tab: ViewerTab | undefined, requestId: string): boolean =>
  tab !== undefined && tab.diffRequestId === requestId;

const readFileEffect = (sessionId: number, path: string, requestId: string): Effect => ({
  type: 'viewer/readFile',
  sessionId,
  path,
  requestId,
});

const readDiffEffect = (tab: ViewerTab, sessionId: number, requestId: string): Effect => ({
  type: 'viewer/readDiff',
  sessionId,
  path: tab.path,
  target: tab.diffTarget,
  requestId,
});

export const viewerReducer: SliceReducer<ViewerState> = (state, action): Reduction<ViewerState> => {
  switch (action.type) {
    case 'workspace/closed': {
      if (state === initialViewerState || state.tabs.length === 0) {
        return idle(state);
      }
      return changed(initialViewerState);
    }

    case 'viewer/openRequested': {
      const existing = findTab(state, action.path);

      if (existing) {
        // Already open: activate it rather than opening a duplicate, and reload only if
        // the watcher marked it stale while it was in the background.
        if (state.activePath === action.path && !existing.stale) {
          return idle(state);
        }
        if (!existing.stale) {
          return changed({ ...state, activePath: action.path });
        }
        const refreshed = replaceTab(state, action.path, (tab) => ({
          ...tab,
          stale: false,
          content: { status: 'loading' },
          contentRequestId: action.requestId,
        }));
        return withEffects(
          { ...(refreshed ?? state), activePath: action.path },
          readFileEffect(action.sessionId, action.path, action.requestId),
        );
      }

      // Oldest tab evicted at the ceiling. Evicting the least recently *used* would be
      // nicer but needs a timestamp in state, and the reducer cannot read a clock.
      const room = state.tabs.length >= MAX_TABS ? state.tabs.slice(1) : state.tabs;

      return withEffects(
        {
          tabs: [...room, newTab(action.path, action.requestId)],
          activePath: action.path,
        },
        readFileEffect(action.sessionId, action.path, action.requestId),
      );
    }

    case 'viewer/contentLoaded': {
      const tab = findTab(state, action.path);
      if (!contentIsCurrent(tab, action.requestId)) {
        return idle(state);
      }
      const next = replaceTab(state, action.path, (existing) => ({
        ...existing,
        content: { status: 'ready', value: toDocument(action.response) },
        contentRequestId: null,
      }));
      return next ? changed(next) : idle(state);
    }

    case 'viewer/contentFailed': {
      const tab = findTab(state, action.path);
      if (!contentIsCurrent(tab, action.requestId)) {
        return idle(state);
      }
      // The tab stays open showing why. A file that is too large or binary is a state
      // the user needs to see, not a reason to close what they just clicked.
      const next = replaceTab(state, action.path, (existing) => ({
        ...existing,
        content: { status: 'error', error: action.error },
        contentRequestId: null,
      }));
      return next ? changed(next) : idle(state);
    }

    case 'viewer/diffLoaded': {
      const tab = findTab(state, action.path);
      if (!diffIsCurrent(tab, action.requestId)) {
        return idle(state);
      }
      const next = replaceTab(state, action.path, (existing) => ({
        ...existing,
        diff: { status: 'ready', value: action.diff },
        diffRequestId: null,
      }));
      return next ? changed(next) : idle(state);
    }

    case 'viewer/diffFailed': {
      const tab = findTab(state, action.path);
      if (!diffIsCurrent(tab, action.requestId)) {
        return idle(state);
      }
      const next = replaceTab(state, action.path, (existing) => ({
        ...existing,
        diff: { status: 'error', error: action.error },
        diffRequestId: null,
      }));
      return next ? changed(next) : idle(state);
    }

    case 'viewer/activated': {
      const tab = findTab(state, action.path);
      if (!tab) {
        return idle(state);
      }

      const effects: Effect[] = [];
      let next: ViewerTab = tab;

      // Rule 6 in action: a background tab is only re-read at the moment it becomes
      // visible, not when the change happened.
      if (tab.stale) {
        next = {
          ...next,
          stale: false,
          content: { status: 'loading' },
          contentRequestId: action.contentRequestId,
        };
        effects.push(readFileEffect(action.sessionId, action.path, action.contentRequestId));

        if (tab.mode === 'diff') {
          next = { ...next, diff: { status: 'loading' }, diffRequestId: action.diffRequestId };
          effects.push(readDiffEffect(tab, action.sessionId, action.diffRequestId));
        } else if (tab.diff.status !== 'idle') {
          // Not requested — the tab is showing code — but the cached diff is now wrong,
          // so it is dropped rather than shown next time the user switches.
          next = { ...next, diff: { status: 'idle' }, diffRequestId: null };
        }
      }

      const tabs =
        next === tab ? state.tabs : state.tabs.map((t) => (t.path === action.path ? next : t));

      if (state.activePath === action.path && next === tab) {
        return idle(state);
      }

      return withEffects({ tabs, activePath: action.path }, ...effects);
    }

    case 'viewer/closed': {
      const index = state.tabs.findIndex((tab) => tab.path === action.path);
      if (index === -1) {
        return idle(state);
      }
      const tabs = state.tabs.filter((tab) => tab.path !== action.path);

      // Focus moves rightwards, matching the terminal panel, rather than jumping to the
      // first tab.
      let activePath = state.activePath;
      if (state.activePath === action.path) {
        activePath =
          tabs.length === 0 ? null : (tabs[Math.min(index, tabs.length - 1)]?.path ?? null);
      }

      const next = { tabs, activePath };
      // Closing the last dirty tab releases the quit guard.
      return hasUnsavedWork(state) && !hasUnsavedWork(next)
        ? withEffects(next, { type: 'app/setUnsaved', unsaved: false })
        : changed(next);
    }

    case 'viewer/modeChanged': {
      const tab = findTab(state, action.path);
      if (!tab || tab.mode === action.mode) {
        return idle(state);
      }

      // Performance rule 5: the diff is fetched the first time it is actually looked at,
      // not when the file is opened.
      const needsDiff = action.mode === 'diff' && tab.diff.status === 'idle';

      const next = replaceTab(state, action.path, (existing) => ({
        ...existing,
        mode: action.mode,
        ...(needsDiff
          ? { diff: { status: 'loading' as const }, diffRequestId: action.requestId }
          : {}),
      }));

      if (!next) {
        return idle(state);
      }
      return needsDiff
        ? withEffects(next, readDiffEffect(tab, action.sessionId, action.requestId))
        : changed(next);
    }

    case 'viewer/diffTargetChanged': {
      const tab = findTab(state, action.path);
      if (!tab || tab.diffTarget === action.target) {
        return idle(state);
      }
      const next = replaceTab(state, action.path, (existing) => ({
        ...existing,
        diffTarget: action.target,
        diff: { status: 'loading' },
        diffRequestId: action.requestId,
        diffTop: 0,
      }));
      if (!next) {
        return idle(state);
      }
      return withEffects(
        next,
        readDiffEffect({ ...tab, diffTarget: action.target }, action.sessionId, action.requestId),
      );
    }

    case 'viewer/edited': {
      const tab = findTab(state, action.path);
      if (!tab || tab.content.status !== 'ready') {
        return idle(state);
      }

      const result = applyEdit(tab.content.value.lines, tab.caret, action.operation);

      // A caret move is not an edit. Marking the tab dirty for one would ask the user to save
      // a file they only looked at.
      if (!result.modified) {
        const moved = replaceTab(state, action.path, (existing) =>
          existing.caret.line === result.caret.line && existing.caret.column === result.caret.column
            ? existing
            : { ...existing, caret: result.caret },
        );
        return moved ? changed(moved) : idle(state);
      }

      const next = replaceTab(state, action.path, (existing) => ({
        ...existing,
        content:
          existing.content.status === 'ready'
            ? { status: 'ready', value: { ...existing.content.value, lines: result.lines } }
            : existing.content,
        caret: result.caret,
        dirty: true,
        // Any diff now describes the file on disk, not what is on screen.
        diff: { status: 'idle' },
        diffRequestId: null,
        save: { status: 'idle' },
      }));

      if (!next) {
        return idle(state);
      }
      // Main is told on the first edit, not on every keystroke — the effect key collapses
      // repeats within a burst and the value only changes at the boundary.
      return tab.dirty
        ? changed(next)
        : withEffects(next, { type: 'app/setUnsaved', unsaved: true });
    }

    case 'viewer/saveRequested': {
      const tab = findTab(state, action.path);
      if (!tab || tab.content.status !== 'ready' || !tab.dirty) {
        return idle(state);
      }

      const document = tab.content.value;
      const next = replaceTab(state, action.path, (existing) => ({
        ...existing,
        save: { status: 'saving' },
        saveRequestId: action.requestId,
      }));

      return withEffects(next ?? state, {
        type: 'viewer/writeFile',
        sessionId: action.sessionId,
        path: action.path,
        content: joinForTransport(document.lines),
        eol: document.eol,
        hadBom: document.hadBom,
        requestId: action.requestId,
      });
    }

    case 'viewer/saved': {
      const tab = findTab(state, action.path);
      if (!tab || tab.saveRequestId !== action.requestId) {
        return idle(state);
      }

      const next = replaceTab(state, action.path, (existing) => ({
        ...existing,
        dirty: false,
        // The file on disk now matches the buffer, so the watcher event this write is about to
        // produce is not news.
        changedOnDisk: false,
        save: { status: 'idle' },
        saveRequestId: null,
      }));

      if (!next) {
        return idle(state);
      }
      return hasUnsavedWork(next)
        ? changed(next)
        : withEffects(next, { type: 'app/setUnsaved', unsaved: false });
    }

    case 'viewer/saveFailed': {
      const tab = findTab(state, action.path);
      if (!tab || tab.saveRequestId !== action.requestId) {
        return idle(state);
      }
      // Still dirty: a failed write means the edits are only in memory, which is exactly when
      // the user must not be told they are safe.
      const next = replaceTab(state, action.path, (existing) => ({
        ...existing,
        save: { status: 'failed', error: action.error },
        saveRequestId: null,
      }));
      return next ? changed(next) : idle(state);
    }

    case 'viewer/closeRequested': {
      /*
       * A clean tab closes here and now. A dirty one does not — the overlay slice reacts to
       * this same action by raising a confirmation, and the actual close arrives later as
       * `viewer/closed`. Two slices responding independently to one action is how they
       * coordinate without either reaching into the other (invariant 10).
       */
      if (action.dirty) {
        return idle(state);
      }
      return viewerReducer(state, { type: 'viewer/closed', path: action.path });
    }

    case 'viewer/reloadRequested': {
      const tab = findTab(state, action.path);
      if (!tab) {
        return idle(state);
      }
      const next = replaceTab(state, action.path, (existing) => ({
        ...existing,
        dirty: false,
        changedOnDisk: false,
        stale: false,
        content: { status: 'loading' },
        contentRequestId: action.requestId,
        diff: { status: 'idle' },
        diffRequestId: null,
        save: { status: 'idle' },
        saveRequestId: null,
      }));

      const withoutDirty = next ?? state;
      return withEffects(
        withoutDirty,
        readFileEffect(action.sessionId, action.path, action.requestId),
        ...(hasUnsavedWork(withoutDirty)
          ? []
          : [{ type: 'app/setUnsaved' as const, unsaved: false }]),
      );
    }

    case 'viewer/scrolled': {
      const next = replaceTab(state, action.path, (tab) => {
        const key = action.mode === 'code' ? 'codeTop' : 'diffTop';
        return tab[key] === action.top ? tab : { ...tab, [key]: action.top };
      });
      return next ? changed(next) : idle(state);
    }

    case 'fs/changed': {
      if (state.tabs.length === 0) {
        return idle(state);
      }

      const touched = new Set([...action.batch.files, ...action.batch.directories]);
      const effects: Effect[] = [];
      let anyChanged = false;

      const tabs = state.tabs.map((tab) => {
        // A truncated batch has an incomplete path list, so every tab is suspect.
        const affected = action.batch.truncated || touched.has(tab.path);
        if (!affected) {
          return tab;
        }

        /*
         * A dirty tab is never reloaded, active or not. The spec is unambiguous: "A dirty tab
         * must never be silently reloaded after an external filesystem change. Instead:
         * tab.changedOnDisk = true." Reloading would discard the user's work without asking,
         * and an agent rewriting a file the user is editing is exactly the situation this
         * application exists to supervise.
         */
        if (tab.dirty) {
          if (tab.changedOnDisk) {
            return tab;
          }
          anyChanged = true;
          return { ...tab, changedOnDisk: true };
        }

        // The active tab is reloaded now; the rest are only marked. The spec calls for
        // exactly this asymmetry, and during a checkout it is the difference between
        // reading one file and reading all of them.
        if (tab.path === state.activePath) {
          // Both ids come pre-minted on the action. There is at most one active tab, so
          // two ids per batch is exact rather than a guess.
          const { viewerContentRequestId, viewerDiffRequestId } = action;
          anyChanged = true;
          effects.push(readFileEffect(action.sessionId, tab.path, viewerContentRequestId));

          if (tab.mode === 'diff') {
            effects.push(readDiffEffect(tab, action.sessionId, viewerDiffRequestId));
            return {
              ...tab,
              stale: false,
              content: { status: 'loading' as const },
              contentRequestId: viewerContentRequestId,
              diff: { status: 'loading' as const },
              diffRequestId: viewerDiffRequestId,
            };
          }

          return {
            ...tab,
            stale: false,
            content: { status: 'loading' as const },
            contentRequestId: viewerContentRequestId,
            // Any cached diff is now wrong.
            diff: { status: 'idle' as const },
            diffRequestId: null,
          };
        }

        if (tab.stale) {
          return tab;
        }
        anyChanged = true;
        return { ...tab, stale: true };
      });

      if (!anyChanged) {
        return idle(state);
      }
      return withEffects({ ...state, tabs }, ...effects);
    }

    default:
      return idle(state);
  }
};
