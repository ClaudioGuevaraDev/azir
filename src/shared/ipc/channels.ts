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

  gitStatus: 'git:status',

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
} as const;

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS];
