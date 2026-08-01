# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Azir is an Electron desktop tool for supervising software agents: an agent changes files, Azir
notices, and shows the tree, the diff, the file and a terminal in one window. It is explicitly
**not an IDE** — that line is the deciding argument in several design decisions (no syntax
highlighting, editing limited to typing/deleting/splitting/joining/saving, unified diffs only).

`docs/architecture.md` is the authoritative spec. `README.md` records the toolchain decisions and
the four places where the implementation deliberately deviates from the spec. Read the relevant
section of `docs/architecture.md` before changing behaviour it describes; where the code departs
from it, the departure is argued in a comment at the code that replaces it.

## Commands

The package manager is **pnpm** (≥ 11). `npm` still resolves this project, but installing
with it desynchronises the lockfiles — see the versioning and gotchas sections.

```bash
pnpm run dev          # electron-vite dev server + Electron, renderer HMR
pnpm run typecheck    # tsc over main, preload, renderer and tooling projects
pnpm run lint         # eslint, including the architectural boundary rules
pnpm test             # vitest run: node + renderer + architecture projects
pnpm run build        # typecheck + bundle all three targets
pnpm run dist:dir     # unpacked build (the only way to catch packaging failures)
```

Single test / subset:

```bash
pnpm exec vitest run src/main/git/parseDiff.test.ts   # one file
pnpm exec vitest run --project node                   # main + shared only
pnpm exec vitest run --project renderer               # jsdom only
pnpm exec vitest run -t 'rejects a stale response'    # by test name
pnpm run test:e2e                                     # electron-vite build, then all Playwright specs
pnpm exec playwright test e2e/git.spec.ts             # one spec — needs a prior `pnpm run build`
```

E2E runs against a real Electron process, serially (`workers: 1`), so it is slow; prefer unit tests
unless the behaviour only exists across the process boundary.

## Architecture

Four layers, and the boundaries between them are enforced mechanically:

- `src/main/` — Electron main. Owns **every** privileged resource: filesystem, `git` (shelled out),
  `node-pty`, `chokidar`, settings, dialogs.
- `src/preload/` — a literal map from domain method to channel constant. No logic, and no Node
  either (`sandbox: true`).
- `src/renderer/` — React, reducer, effects, xterm.js. Browser-only, treated as untrusted.
- `src/shared/` — types, zod schemas, channel constants. Compiled into all three; zod is its only
  permitted runtime dependency.

### Unidirectional data flow

```
event → Action → reduce(AppState, Action) → { state, effects } → React + effect runner → IPC → Action
```

- `src/renderer/app/reducer/index.ts` is the root reducer and the **only** writer of renderer state.
  It is pure; it returns `Effect` data and never performs work.
- `combineSlices` (`reducer/combine.ts`) composes per-domain slices. Two properties it guarantees
  and that tests pin down: identity is preserved when nothing changed (otherwise every keystroke
  re-renders the workspace), and effect order is deterministic (slice map insertion order).
  Cross-slice reactions need no mediator — each slice handles the same action independently.
- `createStore` (`app/store.ts`) commits state before notifying, runs effects after notifying, and
  queues re-entrant dispatches instead of recursing. Read its doc comment before touching it.
- `runtime/effectRunner.ts` is the only place in the renderer that touches `window.azir` and the
  only place a `Result` is unwrapped. It takes the bridge as an argument so tests can fake it.
- Request ids are minted at the dispatch edge, never inside the reducer.

### IPC spine

- Every channel name is a literal in `src/shared/ipc/channels.ts`. The renderer never names a
  channel.
- Handlers are registered through `handle` / `handleResult` / `listen` in `src/main/ipc/handle.ts`,
  never `ipcMain.handle` directly. Those wrappers zod-validate the payload and guarantee nothing
  escapes as a rejection.
- The boundary is **total**: it returns `Result<T>` (`src/shared/ipc/result.ts`) with a closed set
  of `AppErrorCode`s. Failures become application state, not crashes. Use `handleResult` when
  failure is an ordinary outcome; `handle` when a throw would be a bug; `listen` for
  fire-and-forget (keystrokes, resizes, settings patches).
- Adding a channel means: constant in `channels.ts`, request schema + response type in
  `contracts.ts`, method on `AppBridge` in `bridge.ts`, one line in `preload/index.ts`, handler in
  `main/ipc/register.ts`.

### The session gate

`SessionRegistry` (`main/workspace/sessions.ts`) mints workspace session ids; the renderer never
does. Every session-scoped request carries one, and handlers call `sessions.require(id)` or
`sessions.resolve(id, relativePath)` — `resolve` is the session check _and_ the path sandbox in one
call. Roots, cwds and the shell always come from main's own records, never from the request. The
reducer has the matching coarse gate: `isStale` drops any action whose session is not the live one.
Disposal is **synchronous** throughout, because Electron will not restart a quit sequence.

### Things that look wrong and are not

- **Terminal bytes never enter the reducer.** They travel a side channel
  (`renderer/terminal/registry.ts`) straight to the pane's xterm.js controller, which buffers for a
  pane React has not mounted yet. The reducer only learns `terminal/activity` — one throttled bit.
  `terminal/sideChannel.test.tsx` asserts 10,000 chunks cause zero re-renders.
- **`terminal/write` and `terminal/resize` are not effects**, and go from the controller to the
  bridge directly.
- **Path search has no IPC channel.** It runs in the renderer against an index main pushes over, so
  the reducer emits no effect for it. Content search runs in main as a literal case-insensitive
  substring scan — not a regex, because the query is untrusted input into the process every PTY byte
  flows through.
- **Long main-process work yields the event loop at a fixed interval** (index walk, content scan),
  and git goes through a coalescing `boundedScheduler`. PTY traffic gets no scheduler at all.
- **Settings travel as patches of whole groups**; main owns the merge, so a group a future version
  writes survives instead of being erased.
- **File writes are serialised per path** through `filesystem/keyedSerialQueue.ts`, because the
  watcher is live while the user types.
- Caret columns in the editor are **grapheme** indexes via `Intl.Segmenter`, not code-unit indexes.

## Enforced constraints

Four mechanisms, not conventions — expect to fight them if you put code in the wrong layer:

1. `tsconfig.renderer.json` omits `types: ["node"]`, so Node imports in the renderer fail typecheck.
2. `eslint.config.mjs` adds per-directory `no-restricted-imports`, catching forms the type layer
   cannot see (dynamic imports, `require` shims) plus `electron`, `node-pty`, `chokidar`.
3. `test/boundaries.test.ts` asserts that lint rule actually fires — and does _not_ fire in main.
4. `windows/mainWindow.test.ts` asserts the mandatory Electron security settings;
   `e2e/smoke.spec.ts` asserts their observable effect.

TypeScript is strict plus `noUncheckedIndexedAccess` and `exactOptionalPropertyTypes` — hence the
`{...(cond ? { error } : {})}` spread idiom rather than passing `undefined`, and the branch in `err()`
rather than an object literal with an optional key.

## Gotchas

- **E2E: every launch needs its own `--user-data-dir`** (use `launchAzir` from `e2e/support.ts`).
  Azir takes a single-instance lock; a shared directory makes a lost race look exactly like flake on
  whichever test happened to be next. `e2e/settings.spec.ts` is the deliberate exception — proving a
  setting survives a restart requires two launches that share one.
- **E2E: read terminal output from `.xterm-rows`**, via `terminalText`/`expectPrompt`. A locator's
  text includes xterm's injected stylesheet, whose child selectors contain `>`, so
  `toContainText('>')` passes vacuously. That bug hid a real regression for two milestones.
- **E2E specs open fixtures in the temp directory, never this repository** — opening a workspace
  starts a watcher, and Playwright writes to `test-results/` while the suite runs.
- **Packaging can break what dev proves works.** `node-pty` must stay outside the asar
  (`asarUnpack`) because Windows cannot `LoadLibrary` a `.node` from an archive and node-pty
  resolves `conpty.dll` and friends relative to itself. Verify with `pnpm run dist:dir` then launch
  `release/win-unpacked/Azir.exe` and run a command in its terminal. Check the asar's contents
  too: a build that collects **zero** production dependencies still succeeds and only dies later,
  when a terminal is opened. There should be four — `chokidar`, `node-addon-api`, `node-pty`,
  `readdirp`.
- **pnpm's settings live in `pnpm-workspace.yaml`, and there is no `.npmrc` on purpose.** pnpm 11
  reads only auth and registry from `.npmrc`; anything else there is ignored _silently_. Putting
  `node-linker=hoisted` in an `.npmrc` looks authoritative and does nothing.
- **The flat `node_modules` is load-bearing** (`nodeLinker: hoisted`). electron-builder's
  `asarUnpack` glob, playwright-core's `require("electron/index.js")` from its own directory, and
  node-pty's `../prebuilds/…/pty.node` all resolve by layout. Switching to pnpm's default isolated
  linker breaks **packaging**, not the tests — the e2e suite can stay green while `dist:dir`
  produces something that dies on first terminal.
- **The install-script denials are written twice**, once per package manager, and must agree:
  `allowScripts` in `package.json` (npm 12) and `allowBuilds` in `pnpm-workspace.yaml` (pnpm 11).
  The observable check is that `node_modules/node-pty/build/` never exists.
- **`"type": "commonjs"` is required** (CJS preload for `sandbox: true`, node-pty's helper
  resolution, `__dirname` for the packaged `loadFile`). No top-level `await` in main; `bootstrap()`
  absorbs it.
- **Some dependency versions are pinned by peer ranges, not preference**: Vite stays on 7
  (electron-vite peer), TypeScript on 5.9 (typescript-eslint peer), `@vitejs/plugin-react` on 5.x.
- `dependencies` holds only native addons; React, zod and xterm are devDependencies because Rollup
  bundles them.
- **Windows is the only verified platform.** macOS/Linux seams are written but unverified, and Linux
  has no `node-pty` prebuilds (falls back to `node-gyp`).

## Conventions

- Invariant 15 — "no abstraction is added without an actual caller" — is applied aggressively, and is
  the stated reason three of the spec's six settings groups do not exist.
- Comments explain _why_, especially where a decision was measured rather than assumed. Several say
  so explicitly; match that register instead of restating what the code does.
- Reserved keyboard shortcuts are deliberately confined to `Ctrl+digit`, `Ctrl+Shift+letter` and
  non-shell function keys, matched on `event.code`, because readline owns nearly every bare
  `Ctrl+letter` (see `runtime/keybindings.ts`).
- Tests live beside the code as `*.test.ts(x)`; cross-cutting assertions about the project itself go
  in `test/`.
- Import aliases: `@shared`, `@main`, `@renderer` (configured in each tsconfig, `vitest.config.ts`
  and `electron.vite.config.ts` — all three need updating together).

## Versioning on /conventional-commit

Invoking the `conventional-commit` skill **always** bumps the app version as part of the same
change, before the commit is created — so the version and the commit that introduced it never
disagree.

Rules for `A.B.C`:

- **Only `B` (minor) and `C` (patch) may be raised.** `A` (major) is off-limits without an explicit
  instruction from the user; nothing in this workflow may reach `1.0.0` on its own.
- Choose between minor and patch from what the commit actually does: a new capability, a new IPC
  channel, a new panel or setting → minor; a fix, a refactor, a test, a comment, a build or tooling
  change → patch. When a commit contains both, the highest applicable level wins.
- A minor bump resets the patch to `0` (`0.4.7` → `0.5.0`), per semver.

Bump it with `pnpm version <minor|patch> --no-git-tag-version --no-git-checks`, then stage
`package.json` with the rest of the change so one commit carries both. Both flags are required, and
for different reasons: without `--no-git-tag-version` the command creates its own commit and tag, and
the commit message is the skill's job; without `--no-git-checks` it aborts with
`ERR_PNPM_UNCLEAN_WORKING_TREE`, because by the time the bump happens the change being committed is
already in the tree (verified — npm had no such check, so this is new).

**Exactly one file changes.** `pnpm-lock.yaml` does not record the root package's own version, only
its dependencies' (verified). `package.json` is the single source: `electron-builder.yml` reads it
from there and no code in `src/` displays it. Do not reach for `npm version` — it would leave
`package.json` bumped and try to maintain a `package-lock.json` this project no longer has.
