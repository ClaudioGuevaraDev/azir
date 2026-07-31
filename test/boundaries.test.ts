import { ESLint } from 'eslint';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * A lint rule with no test is a lint rule that gets switched off during a
 * frustrating afternoon and never switched back on.
 *
 * docs/architecture.md makes the renderer boundary an invariant, not a
 * convention: "The renderer never imports fs, path, child_process, electron or
 * node-pty" and "The renderer must be treated as untrusted relative to the
 * operating system." This suite asserts that the mechanism enforcing it in
 * eslint.config.mjs actually fires — and, just as importantly, that it does not
 * fire on the main process, where those imports are correct.
 *
 * `lintText` resolves the flat config from `filePath` without the file needing
 * to exist on disk, so no fixture files are committed and nothing has to be
 * excluded from typecheck.
 */

let eslint: ESLint;

const lint = async (filePath: string, code: string): Promise<string[]> => {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((message) => message.ruleId ?? 'unknown');
};

const importOf = (module: string): string => `import x from '${module}';\nexport default x;\n`;

beforeAll(() => {
  eslint = new ESLint({ cwd: process.cwd() });
});

describe('renderer boundary', () => {
  it.each([
    'fs',
    'node:fs',
    'path',
    'node:path',
    'child_process',
    'node:child_process',
    'os',
    'electron',
    'node-pty',
  ])('rejects `import from "%s"` in the renderer', async (module) => {
    const ruleIds = await lint('src/renderer/probe.ts', importOf(module));
    expect(ruleIds).toContain('no-restricted-imports');
  });

  it('rejects reaching into main-process code from the renderer', async () => {
    const ruleIds = await lint('src/renderer/probe.ts', importOf('@main/terminal/terminalManager'));
    expect(ruleIds).toContain('no-restricted-imports');
  });

  it('allows the shared contract, which is the sanctioned route', async () => {
    const ruleIds = await lint('src/renderer/probe.ts', importOf('@shared/ipc/channels'));
    expect(ruleIds).not.toContain('no-restricted-imports');
  });
});

describe('main process', () => {
  it.each(['fs', 'node:fs', 'child_process', 'electron', 'node-pty'])(
    'allows `import from "%s"`, which is where privileged work belongs',
    async (module) => {
      const ruleIds = await lint('src/main/probe.ts', importOf(module));
      expect(ruleIds).not.toContain('no-restricted-imports');
    },
  );
});

describe('preload', () => {
  it('allows electron, its one legitimate dependency', async () => {
    const ruleIds = await lint('src/preload/probe.ts', importOf('electron'));
    expect(ruleIds).not.toContain('no-restricted-imports');
  });

  it('rejects Node builtins, because the window runs with sandbox:true', async () => {
    const ruleIds = await lint('src/preload/probe.ts', importOf('node:fs'));
    expect(ruleIds).toContain('no-restricted-imports');
  });
});

describe('shared', () => {
  it.each(['fs', 'electron', 'node-pty'])(
    'rejects `import from "%s"`, since shared compiles into all three processes',
    async (module) => {
      const ruleIds = await lint('src/shared/probe.ts', importOf(module));
      expect(ruleIds).toContain('no-restricted-imports');
    },
  );

  it('rejects depending on a specific process, which would invert the dependency direction', async () => {
    const ruleIds = await lint('src/shared/probe.ts', importOf('@renderer/app/store'));
    expect(ruleIds).toContain('no-restricted-imports');
  });

  it('allows zod', async () => {
    const ruleIds = await lint('src/shared/probe.ts', importOf('zod'));
    expect(ruleIds).not.toContain('no-restricted-imports');
  });
});
