import { beforeEach, describe, expect, it, vi } from 'vitest';

const openExternal = vi.fn();

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  shell: { openExternal },
}));

const { openExternalIfSafe } = await import('./security');

beforeEach(() => {
  openExternal.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('openExternalIfSafe', () => {
  it.each(['https://example.com/docs', 'http://localhost:3000/', 'mailto:someone@example.com'])(
    'hands %s to the OS',
    (url) => {
      openExternalIfSafe(url);
      expect(openExternal).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    // Passing an unvalidated string to shell.openExternal lets content choose
    // which program runs. Each of these resolves to a handler on a real machine.
    'file:///C:/Windows/System32/cmd.exe',
    'smb://attacker/share',
    'javascript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vscode://file/C:/secrets',
    'ms-msdt:/id',
  ])('refuses %s', (url) => {
    openExternalIfSafe(url);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it.each(['', 'not a url', '://missing-scheme'])('ignores the unparseable input %o', (url) => {
    expect(() => openExternalIfSafe(url)).not.toThrow();
    expect(openExternal).not.toHaveBeenCalled();
  });
});
