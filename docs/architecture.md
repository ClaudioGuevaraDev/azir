# Architecture

## Product intent

Azir is a desktop supervision tool for software agents.

The core loop is:

```text
Agent changes files
      ↓
Workspace detects changes
      ↓
User reviews code, diff and terminal output
      ↓
User decides what to do next
```

Azir is not a full IDE. It may allow small, controlled edits inside the viewer, but its primary purpose is to observe, inspect and supervise work performed by an agent.

The architecture must keep that loop fast, predictable and testable.

---

## Technology stack

```text
Electron
TypeScript
React
xterm.js
node-pty
chokidar
Node.js child_process
```

Recommended additions:

```text
Vite
Zustand or a small custom store
zod
electron-builder
```

React is responsible only for rendering the interface.

Electron's main process owns all privileged and long-lived system resources:

- PTY processes
- filesystem access
- git processes
- file watchers
- application windows
- native dialogs
- settings persistence

The renderer process must never access Node.js APIs directly.

---

## Process model

```text
┌──────────────────────────────────────────────┐
│ Electron Main Process                        │
│                                              │
│  filesystem · git · node-pty · chokidar      │
│  settings · native dialogs · app lifecycle   │
└──────────────────────┬───────────────────────┘
                       │ typed IPC
┌──────────────────────▼───────────────────────┐
│ Preload                                      │
│                                              │
│ exposes a small, validated application API   │
└──────────────────────┬───────────────────────┘
                       │ contextBridge
┌──────────────────────▼───────────────────────┐
│ Renderer                                     │
│                                              │
│ React · state · reducer · xterm.js · layout  │
└──────────────────────────────────────────────┘
```

Rules:

1. `contextIsolation` is enabled.
2. `nodeIntegration` is disabled.
3. The deprecated `remote` module is never used.
4. The renderer never imports `fs`, `path`, `child_process`, `electron` or `node-pty`.
5. Every IPC command has a typed request and response.
6. IPC handlers validate untrusted input before using it.
7. The renderer may only access capabilities explicitly exposed by the preload bridge.

---

## Unidirectional data flow

```text
keyboard · mouse · IPC event · resize
                  ↓
                Action
                  ↓
       reduce(AppState, Action)
                  ↓
          State + Effect[]
             ↓          ↓
        React UI     effect runner
                        ↓
                    IPC command
                        ↓
                 Electron main
                        ↓
                    IPC event
                        ↓
                     Action
```

The application follows four invariants:

1. **The reducer is the only writer of renderer state.**
2. **The reducer is pure.**
3. **React components only render state and dispatch actions.**
4. **Panels never call each other directly.**

A component may dispatch an action, but it must not directly mutate shared state, read files, execute git or control a PTY.

All external work is described as an `Effect`.

```ts
type Reduction = {
  state: AppState;
  effects: Effect[];
};
```

The reducer describes what must happen. It never performs the work itself.

---

## Renderer state

```ts
interface AppState {
  workspace: WorkspaceState | null;
  repository: RepositoryState;
  viewer: ViewerState;
  terminals: TerminalState;
  layout: LayoutState;
  focus: FocusState;
  overlays: OverlayState;
  settings: SettingsState;
  notices: Notice[];
}
```

State stores serializable application data whenever possible.

Long-lived system handles do not belong in renderer state:

- PTY process handles
- filesystem watchers
- child processes
- BrowserWindow instances
- file descriptors

Those resources belong to the Electron main process.

The renderer stores only identities and snapshots:

```ts
type TerminalPaneId = string;
type FileId = string;
type RequestId = string;
```

Stable identities are preferred over array positions.

---

## Actions

Actions describe user intent or completed external work.

```ts
type Action =
  | { type: 'workspace/openRequested' }
  | { type: 'workspace/opened'; root: string }
  | { type: 'workspace/closed' }
  | { type: 'repository/refreshRequested' }
  | { type: 'repository/refreshed'; snapshot: RepositorySnapshot }
  | { type: 'viewer/openRequested'; path: string }
  | { type: 'viewer/opened'; path: string; document: Document }
  | { type: 'viewer/saveRequested'; path: string }
  | { type: 'viewer/saved'; path: string }
  | { type: 'terminal/createRequested' }
  | { type: 'terminal/created'; paneId: TerminalPaneId }
  | { type: 'terminal/output'; paneId: TerminalPaneId; data: string }
  | { type: 'terminal/exited'; paneId: TerminalPaneId; exitCode: number | null }
  | { type: 'layout/resized'; width: number; height: number }
  | { type: 'focus/changed'; panel: FocusedPanel }
  | { type: 'overlay/opened'; overlay: Overlay }
  | { type: 'overlay/closed' };
```

Actions must contain facts or intentions, not executable callbacks.

---

## Effects

Effects describe privileged or asynchronous work.

```ts
type Effect =
  | { type: 'workspace/pickFolder' }
  | { type: 'repository/scan'; root: string }
  | { type: 'git/status'; root: string }
  | { type: 'git/diff'; root: string; path: string; requestId: string }
  | { type: 'file/read'; path: string; requestId: string }
  | { type: 'file/write'; path: string; content: string }
  | { type: 'terminal/create'; cwd: string; paneId: TerminalPaneId }
  | { type: 'terminal/write'; paneId: TerminalPaneId; data: string }
  | { type: 'terminal/resize'; paneId: TerminalPaneId; cols: number; rows: number }
  | { type: 'terminal/kill'; paneId: TerminalPaneId }
  | { type: 'watcher/start'; root: string }
  | { type: 'watcher/stop' }
  | { type: 'settings/save'; settings: Settings };
```

The renderer effect runner converts effects into calls to the preload API.

The main process performs the work and returns events.

---

## Typed IPC contract

IPC names and payloads live in a shared package that contains types only.

```text
src/shared/ipc/
  channels.ts
  requests.ts
  responses.ts
  events.ts
  schemas.ts
```

Example:

```ts
interface AppBridge {
  workspace: {
    pickFolder(): Promise<string | null>;
  };

  files: {
    read(request: ReadFileRequest): Promise<ReadFileResponse>;
    write(request: WriteFileRequest): Promise<void>;
  };

  git: {
    status(request: GitStatusRequest): Promise<GitStatusResponse>;
    diff(request: GitDiffRequest): Promise<GitDiffResponse>;
  };

  terminal: {
    create(request: CreateTerminalRequest): Promise<void>;
    write(request: WriteTerminalRequest): void;
    resize(request: ResizeTerminalRequest): void;
    kill(request: KillTerminalRequest): void;
    onData(listener: (event: TerminalDataEvent) => void): Unsubscribe;
    onExit(listener: (event: TerminalExitEvent) => void): Unsubscribe;
  };
}
```

The bridge exposes domain operations, not raw `ipcRenderer`.

Bad:

```ts
window.electron.send(channel, payload);
```

Good:

```ts
window.azir.terminal.resize({ paneId, cols, rows });
```

The preload layer is the public boundary between the renderer and Electron.

---

## Module boundaries

```text
src/
  main/
    app/
    windows/
    ipc/
    filesystem/
    git/
    terminal/
    watcher/
    settings/

  preload/
    bridge.ts
    types.ts

  renderer/
    app/
      actions.ts
      effects.ts
      reducer.ts
      state.ts
      store.ts
    repository/
    viewer/
    terminal/
    layout/
    overlays/
    settings/
    ui/

  shared/
    ipc/
    models/
    constants/
```

Responsibilities:

| Module                | Responsibility                                  |
| --------------------- | ----------------------------------------------- |
| `main/windows`        | BrowserWindow creation and lifecycle            |
| `main/ipc`            | Register validated IPC handlers                 |
| `main/filesystem`     | Read, write and scan files                      |
| `main/git`            | Execute and parse git commands                  |
| `main/terminal`       | Own node-pty processes                          |
| `main/watcher`        | Own chokidar watchers                           |
| `main/settings`       | Read and persist settings                       |
| `preload`             | Expose the safe application API                 |
| `renderer/app`        | Actions, reducer, effects and state             |
| `renderer/repository` | Tree, git projection and repository state       |
| `renderer/viewer`     | Documents, tabs, diffs and editing              |
| `renderer/terminal`   | xterm.js lifecycle and terminal panel UI        |
| `renderer/layout`     | Workspace geometry                              |
| `renderer/overlays`   | Help, settings, search and confirmation dialogs |
| `renderer/ui`         | Presentational components                       |

---

## Repository model

The repository panel combines filesystem and git information into one projection.

```text
filesystem scan ──┐
                  ├──▶ repository projection ──▶ rows ──▶ UI
git status ───────┘
```

There is no separate explorer panel and git changes panel.

Instead, the same data can be projected into views such as:

```ts
type RepositoryView = 'tree' | 'changes' | 'session';
```

Rules:

- Files are identified by normalized absolute path.
- Visual row indexes are never identities.
- Directories load lazily.
- Loading state is explicit.
- Directory order is deterministic.
- Git-only deleted files may exist as virtual nodes.
- Projection is rebuilt in one place.
- Selection survives refresh when the selected path still exists.

Example:

```ts
type DirectoryChildren =
  | { status: 'unloaded' }
  | { status: 'loading' }
  | { status: 'loaded'; children: FileNode[] }
  | { status: 'failed'; error: string };
```

---

## Filesystem watcher

The main process owns a `chokidar` watcher for the active workspace.

```text
filesystem
    ↓
chokidar
    ↓
filter
    ↓
coalesce
    ↓
typed IPC event
    ↓
renderer action
```

The watcher must not send one full refresh for every low-level filesystem event.

Events are coalesced by path and flushed in batches.

The reducer response should be targeted:

- refresh git status
- rescan affected directories that are already expanded
- reload the active file when it changed
- invalidate background tabs rather than eagerly re-read all of them

Ignored directories must be shared by the scanner and watcher so they cannot disagree about what exists.

Typical ignored paths:

```text
.git/objects
node_modules
dist
build
target
coverage
```

Relevant `.git` paths such as `HEAD`, `index` and `refs` should trigger a git refresh.

---

## Git

Azir invokes the system `git` binary using `child_process.spawn`.

It does not reimplement git semantics.

Advantages:

- exact `.gitignore` behaviour
- worktree support
- submodule behaviour
- repository configuration consistency
- lower semantic drift from the user's terminal

All commands must use piped stdio.

Never inherit renderer or application stdio.

Recommended flags:

```text
--no-optional-locks
--no-pager
```

For diffs:

```text
--no-color
--no-ext-diff
--unified=<fixed value>
```

Paths must be passed safely and never interpolated into a shell command.

Bad:

```ts
exec(`git diff -- ${path}`);
```

Good:

```ts
spawn('git', ['diff', '--no-color', '--', path], {
  cwd: root,
  shell: false,
});
```

Git failures are application states, not crashes.

Examples:

- git is not installed
- folder is not a repository
- repository has no commits
- command timed out
- path no longer exists

---

## Code viewer

```text
file bytes ──▶ decode ──▶ Document ──┐
                                     ├──▶ viewer
git diff ──▶ parse ──▶ FileDiff ─────┘
```

The viewer owns:

- open tabs
- active tab
- code mode
- diff mode
- viewport
- search state
- optional edit mode

Each tab has a stable path identity.

```ts
interface ViewerTab {
  path: string;
  content: ViewerContent;
  diff: DiffContent;
  codePosition: ViewerPosition;
  diffPosition: ViewerPosition;
  dirty: boolean;
  changedOnDisk: boolean;
}
```

Every async file or diff response carries both:

```ts
path;
requestId;
```

The reducer accepts the response only when it still belongs to the relevant request.

This prevents stale responses from replacing newer content.

Background tabs may receive valid results, but only the active tab causes an immediate visible update.

---

## Editing

Editing is intentionally limited.

```text
key
 ↓
EditOperation
 ↓
pure Document operation
 ↓
dirty tab
 ↓
save effect
 ↓
main process writes file
 ↓
saved event
```

The viewer may support:

- character insertion
- newline
- backspace
- delete
- caret movement
- save

It does not need to become a complete editor.

No requirement exists for:

- undo history
- multi-cursor
- language servers
- refactoring
- advanced selection
- replace across files

The document model must use character-safe indexing.

JavaScript string indexes are UTF-16 code units, so operations must not assume that one index always equals one visible character.

Use helpers based on code points or grapheme segmentation where necessary.

A dirty tab must never be silently reloaded after an external filesystem change.

Instead:

```ts
tab.changedOnDisk = true;
```

Closing a dirty tab or quitting the application requires confirmation.

Writes must be serialized per path.

A newer save for the same path may replace an older pending save, but a save must never be dropped merely because other work is queued.

---

## Integrated terminal

The terminal has two layers:

```text
Renderer                         Main process

xterm.js                         node-pty
Terminal instance  ◀───────────  PTY output
Keyboard input     ───────────▶  PTY write
Resize             ───────────▶  PTY resize
```

`xterm.js` is the terminal emulator and renderer.

`node-pty` owns the real shell process.

The renderer must never spawn shells directly.

### Terminal identities

Every pane has a stable ID.

```ts
type TerminalPaneId = string;
```

The ID travels with every command and event:

```ts
{
  (paneId, data);
}
{
  (paneId, cols, rows);
}
{
  (paneId, exitCode);
}
```

An event for a pane that no longer exists is ignored.

IDs are never reused during the lifetime of a workspace.

This prevents late PTY output from being delivered to a newly created terminal that occupies the same visual position.

### Terminal lifecycle

```text
Idle
  ↓ create
Starting
  ↓ ready
Running
  ↓ process exits
Exited
```

The main process owns:

```ts
interface PtySession {
  id: TerminalPaneId;
  process: IPty;
  cwd: string;
}
```

Closing a pane kills its PTY.

Closing a workspace kills all PTYs owned by that workspace.

Closing the application kills all remaining PTYs.

### xterm.js lifecycle

Each visible pane owns one `Terminal` instance.

Recommended addons:

```text
@xterm/addon-fit
@xterm/addon-web-links
@xterm/addon-search
@xterm/addon-unicode11
```

A `ResizeObserver` watches each terminal container.

After layout settles:

```ts
fitAddon.fit();
window.azir.terminal.resize({
  paneId,
  cols: terminal.cols,
  rows: terminal.rows,
});
```

Resize requests should be deduplicated.

Do not resize the PTY repeatedly when rows and columns did not change.

Terminal output should be buffered briefly and written to xterm.js in batches when bursts are large.

### Terminal input

```ts
terminal.onData((data) => {
  window.azir.terminal.write({ paneId, data });
});
```

xterm.js already translates browser keyboard input into terminal sequences.

Application shortcuts must be intercepted before they reach xterm.js only when they belong to workspace management.

The terminal should retain most keys:

- `Ctrl+C`
- `Ctrl+D`
- `Ctrl+R`
- `Tab`
- arrows
- function keys used by the shell

The application should reserve only a small, documented set for:

- quitting
- switching panels
- adding or closing terminal panes
- workspace-level actions

---

## Multiple terminal panes

The terminal remains one workspace panel even when it contains several PTYs.

```ts
interface TerminalState {
  panes: TerminalPaneState[];
  activePaneId: TerminalPaneId;
}
```

Rules:

- the collection is never empty while the workspace is active
- pane IDs are stable
- there is a fixed maximum
- layout determines how many panes fit visibly
- hidden panes continue running
- narrowing the window never kills a PTY
- switching the active pane does not recreate xterm.js or node-pty

The split direction is derived from available geometry.

It is not a separate setting unless there is a real user need for it.

---

## Layout

The workspace has three conceptual panels:

```text
Repository
Viewer
Terminal
```

Panel order and arrangement are separate settings.

```ts
type Panel = 'repository' | 'viewer' | 'terminal';

interface LayoutSettings {
  order: [Panel, Panel, Panel];
  arrangement: 'columns' | 'two-over-one' | 'sidebar-and-stack' | 'rows';
}
```

The layout engine receives slot order and returns rectangles.

It must not know which panel occupies each slot.

Responsive fallback:

```text
Full layout
    ↓ insufficient space
Two-panel layout
    ↓ insufficient space
Focused panel only
```

The focused panel remains visible.

Small windows produce a useful reduced layout, never an exception.

---

## Search

Search has two modes:

```text
path search
content search
```

Path search operates on an in-memory path index and should respond on every keystroke without IPC.

Content search requires filesystem access and runs in the main process or in a dedicated worker thread.

Every content-search result carries:

```ts
query;
requestId;
```

The reducer drops results for a query that is no longer current.

Latest query wins.

Large searches must not block:

- PTY input
- terminal output
- file reads
- git refresh
- UI rendering

---

## Overlays

Help, settings, search and confirmation dialogs are overlays, not workspace panels.

They:

- are drawn over the workspace
- do not change panel order
- do not occupy permanent layout slots
- preserve the focused panel underneath
- restore the previous workspace when closed

```ts
type Overlay =
  | { type: 'help' }
  | { type: 'settings' }
  | { type: 'search' }
  | { type: 'confirm'; intent: ConfirmIntent };
```

Only one modal overlay should own keyboard input at a time.

---

## Settings

Settings are loaded by the main process at startup.

The renderer receives validated values.

```ts
interface Settings {
  appearance: AppearanceSettings;
  layout: LayoutSettings;
  repository: RepositorySettings;
  terminal: TerminalSettings;
  editor: EditorSettings;
  updates: UpdateSettings;
}
```

The live settings used by the workspace belong to renderer state.

Persisted settings are only the startup source.

Changing a setting:

```text
UI
 ↓
Action
 ↓
Reducer updates live state
 ↓
SaveSettings effect
 ↓
Main process writes settings
```

Settings writes should be debounced or deduplicated.

Malformed configuration falls back per field rather than discarding the entire file.

---

## Main-process job scheduling

External work must not be managed by one global queue.

PTY traffic is latency-sensitive and must have its own direct route.

Recommended separation:

```text
PTY sessions         direct event-driven path
filesystem reads     async Node operations
git commands         bounded scheduler
content search       worker thread or dedicated queue
watcher              chokidar callback + batching
settings writes      deduplicated queue
```

A slow repository search must never delay terminal input.

A slow git command must never delay PTY output.

The main process may use asynchronous Node APIs, but the architecture must not rely on one serial worker for unrelated domains.

---

## Performance rules

1. React does not rerender the entire workspace for every terminal chunk.
2. Terminal output is delivered directly to the relevant terminal controller.
3. Repository projections are memoized.
4. Files are loaded lazily.
5. Diffs are loaded only when viewed.
6. Background tabs are invalidated rather than eagerly refreshed.
7. Search results use request IDs.
8. Filesystem bursts are coalesced.
9. Git refreshes are deduplicated.
10. PTY resize events are deduplicated.
11. Large lists use virtualization.
12. Large files are rejected or require explicit confirmation.

xterm.js output should not be stored as a giant string in global React state.

The xterm.js instance is the terminal's presentation buffer.

Global state stores only terminal metadata:

```ts
interface TerminalPaneState {
  id: TerminalPaneId;
  title: string;
  lifecycle: TerminalLifecycle;
  cwd: string;
  exitCode: number | null;
}
```

---

## Security

Electron security is an architectural concern, not a final hardening step.

Required settings:

```ts
new BrowserWindow({
  webPreferences: {
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    preload,
  },
});
```

Additional rules:

- validate every IPC payload
- expose no generic filesystem API
- expose no generic command execution API
- never accept arbitrary IPC channel names
- never concatenate shell commands
- use `shell: false`
- restrict navigation
- deny unexpected window creation
- use a strict Content Security Policy
- avoid loading remote renderer content
- sanitize links before opening them externally
- normalize and validate workspace paths
- ensure file operations stay inside the active workspace unless explicitly allowed

The renderer must be treated as untrusted relative to the operating system.

---

## Error handling

External failures become state.

They do not crash the renderer.

Examples:

```ts
type Loadable<T> =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; value: T }
  | { status: 'error'; message: string };
```

Expected failures include:

- unreadable directory
- missing file
- invalid encoding
- binary file
- git unavailable
- non-git workspace
- PTY creation failure
- shell exits immediately
- watcher unavailable
- settings file malformed

The user must always retain a usable application surface when one subsystem fails.

A missing git binary must not disable the file browser.

A watcher failure must not disable manual refresh.

A terminal failure must not prevent reviewing files.

---

## Startup

```text
Electron app ready
      ↓
create BrowserWindow
      ↓
load settings
      ↓
show welcome screen
      ↓
user chooses workspace
      ↓
initialize renderer state
      ↓
start watcher
      ↓
scan repository and git status
      ↓
render first workspace frame
      ↓
create initial PTY when autostart is enabled
```

The window should become visible before expensive workspace work finishes.

Repository scan, git status and terminal startup must not block the first paint.

Opening a second folder creates a new workspace lifecycle.

The previous workspace is disposed completely:

- watcher stopped
- PTYs killed
- pending requests ignored
- repository state discarded
- renderer terminal instances disposed

---

## Shutdown

On application shutdown:

1. stop accepting new workspace effects
2. close all PTYs
3. stop filesystem watchers
4. flush required settings writes
5. remove IPC listeners
6. dispose renderer resources
7. close the window

Cleanup must be idempotent.

Unexpected renderer closure must still cause the main process to destroy PTYs and watchers.

---

## Testing strategy

### Pure unit tests

Test without Electron:

- reducer transitions
- repository projection
- path normalization
- layout computation
- viewer document operations
- search matching
- git output parsers
- action guards
- stale-response rejection

### Main-process unit tests

Mock system boundaries:

- file service
- git runner
- terminal manager
- watcher batching
- settings persistence
- IPC validation

### Integration tests

Run Electron with temporary repositories:

- open workspace
- detect file change
- render git status
- open and save file
- create PTY
- write command
- receive terminal output
- resize terminal
- close pane
- reopen workspace

### End-to-end tests

Use Playwright for Electron.

Test user-visible flows rather than internal implementation.

---

## Core invariants

These rules must remain true as the project grows:

1. The renderer reducer is the only writer of shared UI state.
2. The reducer performs no I/O.
3. React components only render and dispatch.
4. Privileged resources live in the main process.
5. The preload bridge exposes domain APIs, never raw IPC.
6. Every terminal pane has a stable identity.
7. Every async response can be rejected when stale.
8. PTY traffic never waits behind git, search or filesystem scans.
9. Dirty files are never silently overwritten or reloaded.
10. Panels communicate only through actions and shared state.
11. The repository and git status are projected into one model.
12. Reduced window size degrades the layout instead of breaking it.
13. Failure of one subsystem does not make the whole application unusable.
14. Electron security settings are mandatory.
15. No abstraction is added without an actual caller.

---

## Architectural summary

```text
Electron Main
  owns operating-system capabilities

Preload
  exposes a narrow typed API

Renderer
  owns deterministic application state

Reducer
  turns actions into state and effects

Effects
  request external work

IPC events
  return external results as actions

React
  renders state

xterm.js
  renders terminal sessions

node-pty
  owns shell processes

chokidar
  observes the workspace

git
  remains the source of truth for repository status
```

The application should feel like one coherent workspace, not a web page wrapped in Electron.

Electron is the host, TypeScript is the implementation language, xterm.js is the terminal emulator and node-pty is the process boundary. The architecture remains centered on the same principle:

```text
External work is described.
State changes are deterministic.
The UI only renders.
```
