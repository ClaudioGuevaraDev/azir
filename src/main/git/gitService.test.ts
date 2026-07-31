import { describe, expect, it, vi } from 'vitest';
import { ok, type Result } from '@shared/ipc/result';
import { createBoundedScheduler } from '../scheduler/boundedScheduler';
import { classifyGitFailure } from './errors';
import { createGitService } from './gitService';
import type { GitRunResult, GitRunner } from './gitRunner';

const runnerReturning = (
  result: Result<GitRunResult>,
): { runner: GitRunner; calls: Array<readonly string[]> } => {
  const calls: Array<readonly string[]> = [];
  return {
    calls,
    runner: {
      run: async (args) => {
        calls.push(args);
        return result;
      },
    },
  };
};

const success = (stdout: string): Result<GitRunResult> => ok({ stdout, stderr: '', exitCode: 0 });

describe('status invocation', () => {
  it('asks for porcelain v2 with the flags the parser depends on', async () => {
    const { runner, calls } = runnerReturning(success(''));

    await createGitService({ runner }).status('/work/repo');

    const args = calls[0] ?? [];
    // -z because the parsers expect raw bytes rather than C-quoted paths; --branch
    // for the header; -uall so a new directory shows its files instead of collapsing
    // to `dir/`, which is what an agent creating a feature folder looks like.
    expect(args).toContain('--porcelain=v2');
    expect(args).toContain('--branch');
    expect(args).toContain('-z');
    expect(args).toContain('-uall');
  });

  it('does not ask for ignored files', async () => {
    const { runner, calls } = runnerReturning(success(''));

    await createGitService({ runner }).status('/work/repo');

    // Listing them would flood the panel with node_modules, and those paths are
    // filtered from the tree anyway.
    expect(calls[0]).not.toContain('--ignored');
  });

  it('returns the parsed snapshot', async () => {
    const { runner } = runnerReturning(success('# branch.head main\0? new.ts\0'));

    const result = await createGitService({ runner }).status('/work/repo');

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error('unreachable');
    }
    expect(result.value.branch.head).toBe('main');
    expect(result.value.files).toHaveLength(1);
  });
});

describe('failures become state', () => {
  it('passes a runner failure through untouched', async () => {
    const { runner } = runnerReturning({
      ok: false,
      error: { code: 'git-missing', message: 'git is not installed, or not on PATH.' },
    });

    const result = await createGitService({ runner }).status('/work/repo');

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.error.code).toBe('git-missing');
  });

  it('classifies a non-zero exit rather than returning garbage', async () => {
    const { runner } = runnerReturning(
      ok({ stdout: '', stderr: 'fatal: not a git repository', exitCode: 128 }),
    );

    const result = await createGitService({ runner }).status('/work/repo');

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.error.code).toBe('not-a-repository');
  });

  it('never throws', async () => {
    const { runner } = runnerReturning(ok({ stdout: '', stderr: 'weird', exitCode: 3 }));

    await expect(createGitService({ runner }).status('/work/repo')).resolves.toBeDefined();
  });
});

describe('scheduling', () => {
  it('collapses refreshes that pile up behind a busy scheduler into one process', async () => {
    // The coalescing window is the queue, not the whole call. A request that has
    // already *started* is deliberately not joined: it may have read the tree before
    // the change that prompted the new request, so returning its result would serve
    // stale status. Requests still waiting are genuinely the same work.
    let invocations = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const runner: GitRunner = {
      run: async () => {
        invocations += 1;
        // Only the first invocation blocks; the rest return immediately.
        if (invocations === 1) {
          await gate;
        }
        return success('');
      },
    };
    const service = createGitService({
      runner,
      scheduler: createBoundedScheduler({ concurrency: 1 }),
    });

    const first = service.status('/work/repo');
    await new Promise((resolve) => setImmediate(resolve));
    const second = service.status('/work/repo');
    const third = service.status('/work/repo');

    release();
    await Promise.all([first, second, third]);

    // Two processes for three requests: the one that was running, plus the single
    // queued entry the last two shared.
    expect(invocations).toBe(2);
  });

  it('does not collapse refreshes of different repositories', async () => {
    let invocations = 0;
    const runner: GitRunner = {
      run: async () => {
        invocations += 1;
        return success('');
      },
    };
    const service = createGitService({ runner });

    await Promise.all([service.status('/work/a'), service.status('/work/b')]);

    expect(invocations).toBe(2);
  });

  it('keeps git off the path PTY traffic uses by bounding concurrency', async () => {
    // docs/architecture.md: "A slow git command must never delay PTY output." The
    // guarantee here is only that git cannot fork unboundedly; PTY traffic never
    // touches this scheduler at all.
    const scheduler = createBoundedScheduler({ concurrency: 2 });
    let concurrent = 0;
    let peak = 0;

    const runner: GitRunner = {
      run: async () => {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await new Promise((resolve) => setImmediate(resolve));
        concurrent -= 1;
        return success('');
      },
    };
    const service = createGitService({ runner, scheduler });

    await Promise.all(
      Array.from({ length: 10 }, (_, index) => service.status(`/work/repo-${index}`)),
    );

    expect(peak).toBeLessThanOrEqual(2);
  });
});

describe('classifyGitFailure', () => {
  it.each([
    ['fatal: not a git repository (or any of the parent directories): .git', 'not-a-repository'],
    ["fatal: your current branch 'main' does not have any commits yet", 'not-a-repository'],
    ["fatal: ambiguous argument 'HEAD': unknown revision", 'not-a-repository'],
    ['fatal: detected dubious ownership in repository at /work/repo', 'permission-denied'],
    ['error: cannot open .git/config: Permission denied', 'permission-denied'],
    ['fatal: Unable to create /work/repo/.git/index.lock: File exists.', 'timed-out'],
  ])('maps %o to %s', (stderr, expected) => {
    const result = classifyGitFailure(128, stderr);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.error.code).toBe(expected);
  });

  it('falls back to internal for an unfamiliar message', () => {
    const result = classifyGitFailure(1, 'something nobody predicted');

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.error.code).toBe('internal');
    expect(result.error.detail).toBe('something nobody predicted');
  });

  it('is case-insensitive, since git capitalises inconsistently across versions', () => {
    const result = classifyGitFailure(128, 'FATAL: NOT A GIT REPOSITORY');

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error('unreachable');
    }
    expect(result.error.code).toBe('not-a-repository');
  });
});

describe('the runner contract the service relies on', () => {
  it('treats a non-zero exit as a value, not a rejection', async () => {
    // The service branches on exitCode, which only works if the runner resolves for
    // a failed process instead of throwing.
    const run = vi.fn(async () => ok({ stdout: '', stderr: 'fatal: x', exitCode: 128 }));

    const result = await createGitService({ runner: { run } }).status('/work/repo');

    expect(run).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(false);
  });
});
