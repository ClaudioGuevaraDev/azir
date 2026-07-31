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
to its own directory.

## Platform support

Windows is the development and verification platform. macOS and Linux targets are
configured, and the platform-specific seams (shell resolution, path comparison,
builder targets) are written for them — but **they are not verified**. Doing so
needs CI with a platform matrix or real hardware.

## Status

| Milestone                                                           | State       |
| ------------------------------------------------------------------- | ----------- |
| M0 — shell, security, boundaries                                    | done        |
| M1 — typed IPC spine, reducer/effect store                          | in progress |
| M2 — integrated terminal                                            | in progress |
| M3–M8 — repository, git, watcher, viewer, editing, settings, search | not started |
