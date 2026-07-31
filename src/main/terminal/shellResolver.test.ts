import { describe, expect, it } from 'vitest';
import { resolveShell } from './shellResolver';

/**
 * The platform branches are exercised explicitly rather than only on the host, so
 * the macOS and Linux logic is at least covered by tests even though its runtime
 * behaviour is unverified (see the README's platform note).
 */

const nothingExists = (): boolean => false;
const everythingExists = (): boolean => true;

describe('windows', () => {
  const win = { platform: 'win32' as const, exists: nothingExists, env: {} };

  it('defaults to powershell.exe, which is present on every supported version', () => {
    // pwsh.exe is an optional install, so it cannot be the default.
    expect(resolveShell('default', win).path).toBe('powershell.exe');
  });

  it('suppresses the banner, which would eat four lines of a short pane', () => {
    expect(resolveShell('default', win).args).toEqual(['-NoLogo']);
  });

  it.each([
    ['pwsh', 'pwsh.exe'],
    ['powershell', 'powershell.exe'],
    ['cmd', 'cmd.exe'],
  ] as const)('honours an explicit %s', (kind, expected) => {
    expect(resolveShell(kind, win).path).toBe(expected);
  });

  it('gives cmd.exe no arguments', () => {
    expect(resolveShell('cmd', win).args).toEqual([]);
  });

  it('finds Git Bash at its installed location', () => {
    const resolved = resolveShell('bash', {
      platform: 'win32',
      env: {},
      exists: (path) => path === 'C:\\Program Files\\Git\\bin\\bash.exe',
    });

    expect(resolved.path).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
  });

  it('falls back to bash.exe on PATH when no install is found', () => {
    expect(resolveShell('bash', win).path).toBe('bash.exe');
  });
});

describe('macOS', () => {
  it('prefers $SHELL, because that is the shell the user actually chose', () => {
    const resolved = resolveShell('default', {
      platform: 'darwin',
      env: { SHELL: '/opt/homebrew/bin/fish' },
      exists: everythingExists,
    });

    expect(resolved.path).toBe('/opt/homebrew/bin/fish');
  });

  it('falls back to zsh, the default since Catalina', () => {
    const resolved = resolveShell('default', {
      platform: 'darwin',
      env: {},
      exists: (path) => path === '/bin/zsh',
    });

    expect(resolved.path).toBe('/bin/zsh');
  });

  it('starts a login shell so PATH and the prompt match a real terminal', () => {
    const resolved = resolveShell('default', {
      platform: 'darwin',
      env: {},
      exists: (path) => path === '/bin/zsh',
    });

    expect(resolved.args).toEqual(['-l']);
  });

  it('ignores a $SHELL that does not exist', () => {
    const resolved = resolveShell('default', {
      platform: 'darwin',
      env: { SHELL: '/removed/shell' },
      exists: (path) => path === '/bin/zsh',
    });

    expect(resolved.path).toBe('/bin/zsh');
  });

  it('ignores an empty $SHELL', () => {
    const resolved = resolveShell('default', {
      platform: 'darwin',
      env: { SHELL: '' },
      exists: (path) => path === '/bin/zsh',
    });

    expect(resolved.path).toBe('/bin/zsh');
  });
});

describe('linux', () => {
  it('falls back to bash', () => {
    const resolved = resolveShell('default', {
      platform: 'linux',
      env: {},
      exists: (path) => path === '/bin/bash',
    });

    expect(resolved.path).toBe('/bin/bash');
  });

  it('honours an explicit zsh when installed', () => {
    const resolved = resolveShell('zsh', {
      platform: 'linux',
      env: {},
      exists: (path) => path === '/usr/bin/zsh',
    });

    expect(resolved.path).toBe('/usr/bin/zsh');
  });

  it('lands on /bin/sh when nothing else is present, so a pane still opens', () => {
    const resolved = resolveShell('default', {
      platform: 'linux',
      env: {},
      exists: nothingExists,
    });

    expect(resolved.path).toBe('/bin/sh');
    expect(resolved.args).toEqual([]);
  });
});
