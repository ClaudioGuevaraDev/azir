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
} as const;

export type Channel = (typeof CHANNELS)[keyof typeof CHANNELS];
