# Azir

Desktop supervision tool for software agents.

An agent changes files; Azir detects the change, shows you the code, the diff and
the terminal output, and lets you decide what happens next. It is not an IDE —
its purpose is to observe and supervise work performed by an agent.

The authoritative design document is [`docs/architecture.md`](docs/architecture.md).
Anything below that contradicts it is a bug in this file.

## Requirements

| Tool    | Version                                          |
| ------- | ------------------------------------------------ |
| Node.js | ≥ 22 (developed on 24.18)                        |
| npm     | ≥ 12                                             |
| git     | on `PATH` (Azir shells out to the system binary) |

No C++ toolchain, Python or `node-gyp` is needed on Windows or macOS. See
[Native modules](#native-modules) for why, and for the Linux exception.

## Getting started

```bash
npm install     # also fetches the Electron binary via the postinstall hook
npm run dev     # electron-vite dev server + Electron, with renderer HMR
```

Other scripts:

```bash
npm run typecheck   # tsc over all four projects
npm run lint        # eslint, including the architectural boundary rules
npm test            # vitest: node, renderer and architecture suites
npm run test:e2e    # builds, then Playwright against a real Electron process
npm run build       # typecheck + bundle main, preload and renderer
npm run dist        # packaged installer for the current platform
npm run dist:dir    # unpacked build, useful for debugging packaging
```

## Layout

```text
src/
  main/       Electron main process. Owns every privileged resource.
  preload/    contextBridge surface. A literal channel map, no logic.
  renderer/   React, reducer, effects, xterm.js. Untrusted; browser-only.
  shared/     Types, zod schemas and channel constants. No environment deps.
e2e/          Playwright specs driving a real Electron process.
test/         Cross-cutting tests that assert on the project itself.
```

Four boundaries are enforced mechanically rather than by convention:

- `tsconfig.renderer.json` omits `types: ["node"]`, so `import fs from 'fs'`
  in the renderer fails **typecheck**.
- `eslint.config.mjs` adds `no-restricted-imports` per directory, so the same
  import also fails **lint** — including forms the type layer cannot see.
- `test/boundaries.test.ts` asserts that lint rule actually fires, and that it
  does _not_ fire in the main process where those imports are correct.
- `src/main/windows/mainWindow.test.ts` asserts the mandatory Electron security
  settings, and `e2e/smoke.spec.ts` asserts their observable effect (no
  `require`, `process` or `module` in the renderer).

## Toolchain decisions

**`electron-vite` + `electron-builder`.** The build has three targets with three
module formats and three externalisation policies (main CJS, preload CJS with no
`node_modules` requires, renderer ESM). electron-vite models that as three keys
in one config and supplies the dev orchestration; hand-rolling it would be ~250
lines of bespoke tooling for no gain. Electron Forge was rejected because its
value is its packaging pipeline, and `docs/architecture.md` already specifies
electron-builder.

**`"type": "commonjs"`.** `sandbox: true` requires a CJS preload; `node-pty` is a
CJS addon that resolves its helper binaries relative to its own directory; and
`__dirname` is needed for the packaged `loadFile` path. The cost is no top-level
`await` in main, which `bootstrap()` absorbs.

**`dependencies` holds only what must survive into the packaged app** — i.e.
native addons. React, zod and xterm are `devDependencies` because Rollup bundles
them, which keeps the shipped `node_modules` small.

**Version constraints that are not free choices.** `electron-vite` peers on
`vite ^5 || ^6 || ^7`, so Vite must stay on 7 even though 8 is released.
`typescript-eslint` peers on `typescript <6.1`, so TypeScript stays on 5.9 even
though 7 is released. `@vitejs/plugin-react` must be 5.x; 6.x requires Vite 8.

**No Zustand.** The architecture is `reduce(AppState, Action) -> {state, effects}`
with a pure reducer as the only writer. That is a few dozen lines over
`useSyncExternalStore`; a second store would introduce a second writer and
contradict invariant 1.

## Native modules

`node-pty@1.1.0` is **Node-API** based and ships prebuilt binaries in its
tarball. This was verified empirically, not assumed:

- The same `pty.node` spawns a working shell under Node (module ABI 137) **and**
  under Electron (module ABI 146). Node-API is ABI-stable, so there is no
  `electron-rebuild` step and `npmRebuild: false` is set in
  `electron-builder.yml`.
- It also works with npm's install scripts **blocked**, because the prebuilds are
  in the tarball and nothing has to be compiled. `package.json` therefore denies
  install scripts for `node-pty`, `esbuild` and `electron-winstaller` explicitly
  rather than approving them.
- Prebuilds cover `win32-x64`, `win32-arm64`, `darwin-x64` and `darwin-arm64`.

**Linux has no prebuilds.** On Linux, `node-pty`'s install script falls back to
`node-gyp rebuild`, which needs `python3`, `make` and a C++ compiler. A Linux
build must either provide those or vendor a prebuild.

Electron 42 has no `postinstall` of its own — its binary is fetched lazily by
`cli.js` on first run, or eagerly by the `install-electron` bin. The root
`postinstall` script calls the latter so that `npm install` leaves the repo in a
runnable state.

Packaging keeps `**/node_modules/node-pty/**` outside the asar archive
(`asarUnpack`): Windows cannot `LoadLibrary` a `.node` from inside an archive, and
node-pty resolves `conpty.dll`, `OpenConsole.exe` and `winpty-agent.exe` relative
to its own directory. This was verified against a real packaged build — `npm run
dist:dir`, then launching `release/win-unpacked/Azir.exe` and running a command in
its terminal — because "works in dev, dies when installed" is the characteristic
failure here and no unit test can catch it.

## Tests

`npm test` runs Vitest across three projects (node, renderer, and one that asserts on
the project itself). `npm run test:e2e` runs Playwright against a real packaged-shape
Electron, so it needs `npm run build` first.

Two things about the end-to-end suite are worth knowing before changing it.

**Every launch gets its own `--user-data-dir`.** Azir takes a single-instance lock, and
a shared user-data directory means every launch contends for the same one. If the
previous test's Electron has not finished exiting, the next one loses the lock and
quits before creating a window — so Playwright waits for a window that never arrives
and the test dies at its own timeout, on whichever test happened to be next. It reads
exactly like flake and is not. Isolating the directory also cut the suite from 3.6
minutes to 1.5.

**Specs open purpose-built fixtures in the temp directory, never this repository.**
Opening a workspace starts a filesystem watcher, and the live repo contains `release/`
and `test-results/` — the second of which Playwright writes to _while the suite is
running_.

And terminal output is read from `.xterm-rows`, never from the pane's text content: a
locator's text includes the stylesheet xterm injects, whose child selectors contain
`>`. Waiting for a prompt with `toContainText('>')` passes on the first poll whether or
not a shell ever started. That assertion was vacuous for two milestones and hid a real
regression.

## Platform support

Windows is the development and verification platform. macOS and Linux targets are
configured, and the platform-specific seams (shell resolution, path comparison,
builder targets) are written for them — but **they are not verified**. Doing so
needs CI with a platform matrix or real hardware.

## Status

| Milestone                                  | State       |
| ------------------------------------------ | ----------- |
| M0 — shell, security, boundaries           | done        |
| M1 — typed IPC spine, reducer/effect store | done        |
| M2 — integrated terminal                   | done        |
| M3 — filesystem and repository tree        | done        |
| M4 — git status                            | done        |
| M5 — filesystem watcher                    | done        |
| M6 — code viewer and diff                  | done        |
| M7 — editing, layout, overlays             | done        |
| M8 — settings and search                   | not started |

**The product's loop is complete, and the user can now close it.** An agent changes
files; the workspace notices without being asked; the repository panel shows what
moved; the viewer shows the file and its diff; the terminal is right there to act on
it — and a small correction no longer needs a second editor. What remains is settings
and search.

Editing is deliberately limited: type, delete, split and join lines, and save. No
multi-cursor, no find-and-replace, no undo stack beyond what a single edit needs.
The spec is explicit that Azir is not an IDE, and the case it does serve is the one
that actually comes up while supervising — fixing a typo an agent left behind without
leaving the review.

Two things in it are less obvious than they look. Caret columns are **grapheme**
indexes, not code-unit indexes, so an emoji or a combining accent is one press of the
arrow key rather than two or three; `Intl.Segmenter` does the work. And writes are
serialised **per path** through a keyed queue, because the watcher is live while the
user types: without it a save and a reload can interleave on the same file. A newer
queued write replaces an older waiting one but inherits its promise, so no caller is
ever left hanging.

Layout is a pure function from slot indexes to rectangles, which is what makes
degradation testable rather than emergent — as the window shrinks, panels drop out in
a defined order instead of collapsing into unusable slivers. Nothing renders until the
stage has been measured; mounting a terminal into a 0×0 slot is not merely ugly, it
leaves xterm attached to a degenerate grid and the pane permanently blank.

The viewer is read-only in diff mode. Diffs are unified rather than side-by-side because the
panel shares the window with a tree and a terminal, and a split view in that width
truncates both sides. There is no syntax highlighting: the spec is explicit that
Azir is not an IDE, and highlighting means either a grammar engine per language or
a heuristic that misleads often enough to matter. Colour is spent on the thing that
carries information — what changed.

The watcher is the piece that makes the loop closed rather than manual. Raw
filesystem events are coalesced in the main process — by path, behind a trailing
debounce, with a ceiling on the wait so a continuous writer cannot starve the
batch — and translated into consequences before they cross IPC: an add or a delete
makes a _directory_ stale, a write makes a _file_ stale, and a change under the
few watched `.git` paths is one bit. The reducer's response is targeted rather
than a full refresh: only directories that are actually loaded get rescanned, a
content change rescans nothing, and a batch that overflows its path budget
refreshes what is on screen instead of applying a list it knows is incomplete.

### Deviations from the spec, and why

Two things in `docs/architecture.md` are deliberately not implemented as written.
Both are documented at the code that replaces them.

**`terminal/output` is not an action.** The spec lists one, but dispatching an
action per PTY chunk contradicts its own performance rules 1–2 and its statement
that the xterm.js instance is the terminal's presentation buffer. Bytes travel a
side channel to the pane's controller instead (`src/renderer/terminal/registry.ts`).
What the reducer learns is `terminal/activity` — one throttled bit meaning "this
hidden pane produced output". `src/renderer/terminal/sideChannel.test.tsx` asserts
that 10,000 chunks cause zero re-renders, so this cannot regress quietly.

**`terminal/write` and `terminal/resize` are not effects.** Keystrokes and window
drags are continuous and carry no application state; routing them through the
reducer would make every character a state transition.
