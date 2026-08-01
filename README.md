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
| Node.js | ≥ 22.13 (developed on 24.18)                     |
| pnpm    | ≥ 11 (developed on 11.17)                        |
| git     | on `PATH` (Azir shells out to the system binary) |

The Node floor is 22.13 because that is what pnpm 11 requires; below it pnpm exits
before it can explain why.

No C++ toolchain, Python or `node-gyp` is needed on Windows or macOS. See
[Native modules](#native-modules) for why, and for the Linux exception.

## Getting started

```bash
pnpm install     # also fetches the Electron binary via the postinstall hook
pnpm run dev     # electron-vite dev server + Electron, with renderer HMR
```

Other scripts:

```bash
pnpm run typecheck   # tsc over all four projects
pnpm run lint        # eslint, including the architectural boundary rules
pnpm test            # vitest: node, renderer and architecture suites
pnpm run test:e2e    # builds, then Playwright against a real Electron process
pnpm run build       # typecheck + bundle main, preload and renderer
pnpm run dist        # packaged installer for the current platform
pnpm run dist:dir    # unpacked build, useful for debugging packaging
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

**Every version is pinned exactly — no `^`, no `~`.** A range makes the installed
tree depend on the day it was installed, which is a poor trade in any project and a
worse one here: several classes of failure only surface when packaging, so a
dependency that moved by itself makes "it worked last week" unverifiable. The lockfile
already pins the resolved tree, but a lockfile only helps whoever has it — an install
from a bare manifest, or a newly added package, still goes through the specifier.
`savePrefix: ''` in `pnpm-workspace.yaml` keeps `pnpm add` from reintroducing a range,
and `test/dependencies.test.ts` fails if one arrives any other way. `engines` is the
exception on purpose: those are runtime floors, not installs.

So the manifest no longer distinguishes the two reasons a version sits where it does,
and one of them is worth stating. **Some versions are not free choices**, and would
need pinning even without the rule above: `electron-vite` peers on
`vite ^5 || ^6 || ^7`, so Vite must stay on 7 even though 8 is released.
`typescript-eslint` peers on `typescript <6.1`, so TypeScript stays on 5.9 even
though 7 is released. `@vitejs/plugin-react` must be 5.x; 6.x requires Vite 8.

**No Zustand.** The architecture is `reduce(AppState, Action) -> {state, effects}`
with a pure reducer as the only writer. That is a few dozen lines over
`useSyncExternalStore`; a second store would introduce a second writer and
contradict invariant 1.

**`pnpm`, with a deliberately flat `node_modules`.** The store gives content-addressed
installs and a lockfile that resolves the same way twice, which is worth having. What
is _not_ taken is pnpm's default isolated linker: `pnpm-workspace.yaml` sets
`nodeLinker: hoisted`, so the tree stays flat exactly as npm left it.

That is not timidity, it is three specific consumers that resolve by **layout** rather
than by package name, each of which breaks differently under symlinks:

- `electron-builder.yml` unpacks `**/node_modules/node-pty/**` from the asar — a literal
  glob over a physical path.
- `playwright-core` does `require("electron/index.js")` from inside its _own_ directory,
  because `e2e/support.ts` deliberately passes no `executablePath`.
- `node-pty` loads `../prebuilds/win32-x64/pty.node` relative to its own `lib/`.

The strictness worth wanting — an undeclared dependency failing to resolve — is what gets
given up, and knowingly. This repository's standing rule is that packaging can break what
dev proves works, so preserving the layout removes that whole class of failure instead of
one instance of it. On Windows there is a second, duller benefit: no
`.pnpm/<pkg>@<version>/node_modules/…` paths pressing against `MAX_PATH`.

Settings live in `pnpm-workspace.yaml` and there is **no `.npmrc`**. pnpm 11 reads only
auth and registry from `.npmrc`; a `node-linker=hoisted` line there is ignored without a
word, which is worse than absent — config that looks authoritative and governs nothing.

## Native modules

`node-pty@1.1.0` is **Node-API** based and ships prebuilt binaries in its
tarball. This was verified empirically, not assumed:

- The same `pty.node` spawns a working shell under Node (module ABI 137) **and**
  under Electron (module ABI 146). Node-API is ABI-stable, so there is no
  `electron-rebuild` step and `npmRebuild: false` is set in
  `electron-builder.yml`.
- It also works with install scripts **blocked**, because the prebuilds are in the
  tarball and nothing has to be compiled. The three that ship one — `node-pty`,
  `esbuild` and `electron-winstaller` — are therefore denied explicitly rather than
  approved. That policy is written twice, once per package manager, because both can
  still install this project: `allowScripts` in `package.json` is npm 12's mechanism
  (`npm approve-scripts` / `npm deny-scripts`), and `allowBuilds` in
  `pnpm-workspace.yaml` is pnpm 11's. The two lists must agree. pnpm's
  `strictDepBuilds` defaults on, so a _new_ dependency carrying an install script
  aborts the install rather than being skipped quietly — the review step, made
  mandatory instead of remembered. The observable proof that both work:
  `node_modules/node-pty/build/` never comes into existence, because that is what
  node-pty's postinstall would create.
- Prebuilds cover `win32-x64`, `win32-arm64`, `darwin-x64` and `darwin-arm64`.

**Linux has no prebuilds.** On Linux, `node-pty`'s install script falls back to
`node-gyp rebuild`, which needs `python3`, `make` and a C++ compiler. A Linux
build must either provide those or vendor a prebuild.

Electron 42 has no `postinstall` of its own — its binary is fetched lazily by
`cli.js` on first run, or eagerly by the `install-electron` bin. The root
`postinstall` script calls the latter so that `pnpm install` leaves the repo in a
runnable state. `allowBuilds` does not suppress it: it governs dependencies, and the
root package's own lifecycle scripts always run.

Packaging keeps `**/node_modules/node-pty/**` outside the asar archive
(`asarUnpack`): Windows cannot `LoadLibrary` a `.node` from inside an archive, and
node-pty resolves `conpty.dll`, `OpenConsole.exe` and `winpty-agent.exe` relative
to its own directory. This was verified against a real packaged build — `pnpm run
dist:dir`, then launching `release/win-unpacked/Azir.exe` and running a command in
its terminal — because "works in dev, dies when installed" is the characteristic
failure here and no unit test can catch it.

The same check is what qualified the move to pnpm, and it is the check to repeat after
any change to the installer, the linker or `dependencies`. Its four observable results:
the asar contains exactly `chokidar`, `node-addon-api`, `node-pty` and `readdirp`;
`pty.node` sits under `app.asar.unpacked`; the launched binary opens a workspace and
echoes a command typed into its terminal; and a file written from outside makes the
watcher fire. The third and fourth matter most — a build that collects no production
dependencies at all still **succeeds**, and only fails later, when a terminal is opened.

## Tests

`pnpm test` runs Vitest across three projects (node, renderer, and one that asserts on
the project itself). `pnpm run test:e2e` runs Playwright against a real packaged-shape
Electron, so it needs `pnpm run build` first.

Two things about the end-to-end suite are worth knowing before changing it.

**Every launch gets its own `--user-data-dir`.** Azir takes a single-instance lock, and
a shared user-data directory means every launch contends for the same one. If the
previous test's Electron has not finished exiting, the next one loses the lock and
quits before creating a window — so Playwright waits for a window that never arrives
and the test dies at its own timeout, on whichever test happened to be next. It reads
exactly like flake and is not. Isolating the directory also cut the suite from 3.6
minutes to 1.5. `e2e/settings.spec.ts` is the one exception, and it launches Electron
itself: proving a setting survives a restart means two launches that deliberately
_share_ a user-data directory.

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

| Milestone                                  | State |
| ------------------------------------------ | ----- |
| M0 — shell, security, boundaries           | done  |
| M1 — typed IPC spine, reducer/effect store | done  |
| M2 — integrated terminal                   | done  |
| M3 — filesystem and repository tree        | done  |
| M4 — git status                            | done  |
| M5 — filesystem watcher                    | done  |
| M6 — code viewer and diff                  | done  |
| M7 — editing, layout, overlays             | done  |
| M8 — settings and search                   | done  |

**The product's loop is complete, and the user can now close it.** An agent changes
files; the workspace notices without being asked; the repository panel shows what
moved; the viewer shows the file and its diff; the terminal is right there to act on
it — and a small correction no longer needs a second editor.

Every milestone in the plan has landed. What follows is the shape of the last two,
because both contain decisions that are not obvious from the code.

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

**Settings** are loaded by main before the window exists, held live in renderer state,
and written back through a debounced, deduplicated, atomic write. A malformed file
falls back one field at a time — and the fields that fell back are _named_ in the
settings overlay, because a value silently reset is indistinguishable from the
application ignoring the user. There are three groups rather than the spec's six: the
absent ones would each be a setting whose only effect is to be written to a file, or
one that needs a design rather than a checkbox, and both cases are argued where the
type is defined.

The renderer sends _patches_ of whole groups and main owns the merge. That is not
elegance for its own sake — slices cannot see one another, so no slice could assemble a
whole `Settings` document. The shape falls out of the constraint and pays for itself:
a group written by a future version survives a write instead of being erased by it. The
same reasoning removed the shell from the create-terminal request entirely; main reads
it from the settings store, exactly as it already derived the working directory.

**Search** is two features that share a text box. Path search runs entirely in the
renderer against an index main walks once and pushes over — the spec requires it to
answer on every keystroke without IPC, and the reducer enforces that structurally by
having no effect to emit. Content search is a literal, case-insensitive substring scan
in main. Deliberately not a regular expression: the query comes from the untrusted side,
and an arbitrary pattern is a denial of service against the process every PTY byte flows
through.

Both the walk and the scan yield the event loop back at a fixed interval, which is what
invariant 8 — "PTY traffic never waits behind git, search or filesystem scans" — costs
in practice. It is asserted end to end by typing a command into the terminal while a
search over 3,000 files is running and waiting for the echo. A newer query abandons the
older one on both sides: main stops the work, and the reducer drops any answer whose
request id is no longer current. Either alone is insufficient — an abandoned search can
already have its result in the IPC queue.

The index tracks what an agent does, live. It is updated from the watcher's _raw_
events rather than from the coalesced batch, because the batch carries consequences —
which directories are stale, which files changed — and an index needs to know that a
path came into existence. Main and the renderer apply the same deltas from the same
source, so their two copies cannot drift.

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

Four things in `docs/architecture.md` are deliberately not implemented as written.
Each is documented at the code that replaces it.

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

**Three of the six settings groups are absent.** `updates` would configure an update
mechanism that does not exist, and a setting whose only effect is to be written to a
file is a promise the application does not keep. `repository`'s obvious member — show
ignored files — cannot be one field: the scanner and the watcher share a single ignore
list precisely so they cannot disagree about what exists, and pointing a recursive
watcher at `node_modules` is a known way to take the process down. `appearance` keeps
only the code font size. Invariant 15, applied to configuration.

**Content search runs in the main process, not a worker thread.** The spec allows
either. A worker would be a fourth build target and a fourth set of asar path problems
for one module; chunked scanning with an explicit yield between files satisfies the actual
requirement, which is that a search never blocks PTY traffic — and that is asserted
end to end rather than assumed.
