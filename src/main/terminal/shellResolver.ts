import { existsSync } from 'node:fs';
import type { ShellKind } from '@shared/ipc/contracts';

/**
 * Picks the shell executable and its startup arguments.
 *
 * This is the cross-platform seam. docs/architecture.md wants the integrated
 * terminal to feel like the user's own terminal, so the default follows the
 * platform convention and honours `$SHELL` where the platform has one.
 *
 * Verified on Windows only. The macOS and Linux branches are written to the
 * platform conventions but are untested — see the README.
 */

export interface ResolvedShell {
  readonly path: string;
  readonly args: readonly string[];
}

export interface ShellResolverOptions {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly exists?: (path: string) => boolean;
}

const WINDOWS_CANDIDATES: Record<string, string[]> = {
  pwsh: ['pwsh.exe'],
  powershell: ['powershell.exe'],
  cmd: ['cmd.exe'],
  bash: [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'bash.exe',
  ],
};

const POSIX_CANDIDATES: Record<string, string[]> = {
  zsh: ['/bin/zsh', '/usr/bin/zsh'],
  bash: ['/bin/bash', '/usr/bin/bash'],
  pwsh: ['/usr/local/bin/pwsh', '/usr/bin/pwsh', '/opt/microsoft/powershell/7/pwsh'],
};

/**
 * `-NoLogo` suppresses the PowerShell banner, which otherwise takes four lines of
 * a pane that may only be twelve tall. Profiles are deliberately *not* skipped:
 * the user's aliases and prompt are the point of an integrated terminal.
 */
const shellArgs = (path: string, platform: NodeJS.Platform): string[] => {
  const name = path.toLowerCase();
  if (name.endsWith('powershell.exe') || name.endsWith('pwsh.exe') || name.endsWith('pwsh')) {
    return ['-NoLogo'];
  }
  // A login shell on POSIX so PATH and the prompt match what a terminal app gives.
  if (platform !== 'win32' && (name.endsWith('/zsh') || name.endsWith('/bash'))) {
    return ['-l'];
  }
  return [];
};

export const resolveShell = (
  kind: ShellKind = 'default',
  options: ShellResolverOptions = {},
): ResolvedShell => {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const exists = options.exists ?? existsSync;

  const build = (path: string): ResolvedShell => ({ path, args: shellArgs(path, platform) });

  const isBareName = (candidate: string): boolean =>
    !candidate.includes('\\') && !candidate.includes('/');

  /**
   * Absolute candidates are probed on disk; a bare executable name is accepted as
   * is and left for the OS to resolve on PATH, since probing it here would need a
   * PATH walk that `spawn` is about to do anyway.
   */
  const firstUsable = (candidates: readonly string[] | undefined): string | undefined =>
    candidates?.find((candidate) => isBareName(candidate) || exists(candidate));

  if (platform === 'win32') {
    if (kind !== 'default') {
      const explicit = firstUsable(WINDOWS_CANDIDATES[kind]);
      if (explicit !== undefined) {
        return build(explicit);
      }
    }
    // `powershell.exe` is present on every supported Windows version, whereas
    // `pwsh.exe` is an optional install, so it is the safe default.
    return build('powershell.exe');
  }

  if (kind !== 'default') {
    const explicit = firstUsable(POSIX_CANDIDATES[kind]);
    if (explicit !== undefined) {
      return build(explicit);
    }
  }

  const fromEnv = env['SHELL'];
  if (fromEnv !== undefined && fromEnv !== '' && exists(fromEnv)) {
    return build(fromEnv);
  }

  // macOS has defaulted to zsh since Catalina; Linux distributions to bash.
  const fallbacks = platform === 'darwin' ? POSIX_CANDIDATES['zsh'] : POSIX_CANDIDATES['bash'];
  const fallback = fallbacks?.find((candidate) => exists(candidate));
  return build(fallback ?? '/bin/sh');
};
