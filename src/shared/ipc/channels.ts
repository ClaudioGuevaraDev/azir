/**
 * Every IPC channel name lives here, as a literal.
 *
 * docs/architecture.md, Security: "never accept arbitrary IPC channel names".
 * The preload bridge exposes domain methods that close over these constants, so
 * the renderer never gets to name a channel itself.
 *
 * Naming: `domain:verb` for request/response, `event:domain:noun` for
 * main → renderer pushes.
 */
export const CHANNELS = {
  appPing: 'app:ping',

  workspacePickFolder: 'workspace:pickFolder',
  workspaceOpen: 'workspace:open',
  workspaceClose: 'workspace:close',

  filesListDirectory: 'files:listDirectory',
  filesRead: 'files:read',
  filesWrite: 'files:write',

  /**
   * The renderer tells main whether anything is unsaved, so `before-quit` can decide
   * synchronously without a round trip at the moment of quitting.
   */
  appSetUnsaved: 'app:setUnsaved',
  /** The user confirmed quitting with unsaved work. */
  appConfirmQuit: 'app:confirmQuit',

  gitStatus: 'git:status',
  gitDiff: 'git:diff',

  /**
   * Read once at renderer startup. Main has already loaded and validated the file by the time a
   * window exists, so this returns a cached value rather than touching the disk.
   */
  settingsLoad: 'settings:load',
  /**
   * A patch, not a whole document: the renderer's slices each own one group and cannot see the
   * others, and main holds the authoritative persisted copy. Fire-and-forget, because the write
   * is debounced in main and there is no outcome the UI waits on.
   */
  settingsSave: 'settings:save',

  /**
   * Content search. Path search has no channel at all, by design: the spec requires it to answer
   * on every keystroke without IPC, so it runs against the index the renderer already holds.
   */
  searchContent: 'search:content',

  terminalCreate: 'terminal:create',
  terminalWrite: 'terminal:write',
  terminalResize: 'terminal:resize',
  terminalKill: 'terminal:kill',

  // main → renderer. `terminal:data` is the highest-traffic channel in the
  // application by orders of magnitude; see main/terminal/outputPump.ts for why
  // it is batched and src/renderer/terminal/registry.ts for why its payload never
  // reaches the reducer.
  eventTerminalData: 'event:terminal:data',
  eventTerminalExit: 'event:terminal:exit',
  eventFsChanged: 'event:fs:changed',
  eventQuitRequested: 'event:app:quitRequested',
  /** The path index, once it has finished building, and its incremental updates thereafter. */
  eventSearchIndex: 'event:search:index',
  eventSearchIndexDelta: 'event:search:indexDelta',
} as const;

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS];
