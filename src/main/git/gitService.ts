import type { DiffTarget, FileDiff, GitStatusResponse } from '@shared/ipc/contracts';
import { ok, type Result } from '@shared/ipc/result';
import { createBoundedScheduler, type BoundedScheduler } from '../scheduler/boundedScheduler';
import { classifyGitFailure } from './errors';
import { createGitRunner, type GitRunner } from './gitRunner';
import { parseDiff } from './parseDiff';
import { parseStatus } from './parseStatus';

/**
 * Git for the repository panel.
 *
 * Every call goes through a bounded scheduler keyed by `(root, operation)`, so a
 * watcher batch that asks for five refreshes in the same instant produces one `git`
 * process rather than five — performance rule 9. It also keeps git off the path PTY
 * traffic uses, which the spec requires: "A slow git command must never delay PTY
 * output."
 */

export interface GitService {
  status(root: string): Promise<Result<GitStatusResponse>>;
  diff(root: string, relativePosix: string, target: DiffTarget): Promise<Result<FileDiff>>;
}

export interface GitServiceOptions {
  readonly runner?: GitRunner;
  readonly scheduler?: BoundedScheduler;
}

/**
 * `--porcelain=v2` for rename sources and ahead/behind; `--branch` for the header;
 * `-z` so paths are raw bytes rather than C-quoted; `-uall` so a new directory shows
 * its files instead of collapsing to `dir/`, which is what an agent creating a
 * feature folder looks like.
 *
 * `--ignored` is deliberately absent: listing ignored files would flood the panel
 * with `node_modules`, and those paths are filtered from the tree anyway. It becomes
 * a setting in M8.
 */
/** Three lines each side is git's own default and what people expect to read. */
const DIFF_CONTEXT_LINES = 3;

const STATUS_ARGS: readonly string[] = [
  'status',
  '--porcelain=v2',
  '--branch',
  '-z',
  '-uall',
  '--find-renames',
];

export const createGitService = (options: GitServiceOptions = {}): GitService => {
  const runner = options.runner ?? createGitRunner();
  const scheduler = options.scheduler ?? createBoundedScheduler({ concurrency: 2 });

  return {
    status(root) {
      return scheduler.run(`status:${root}`, async () => {
        const result = await runner.run(STATUS_ARGS, { cwd: root });
        if (!result.ok) {
          return result;
        }

        const { exitCode, stdout, stderr } = result.value;
        if (exitCode !== 0) {
          return classifyGitFailure(exitCode, stderr);
        }

        const parsed = parseStatus(stdout);
        return ok<GitStatusResponse>({ branch: parsed.branch, files: parsed.files });
      });
    },

    diff(root, relativePosix, target) {
      return scheduler.run(`diff:${target}:${root}:${relativePosix}`, async () => {
        const args = [
          'diff',
          // --no-color because the viewer renders its own; --no-ext-diff because a
          // user-configured external diff tool would produce something unparseable, or
          // try to open a window.
          '--no-color',
          '--no-ext-diff',
          // A fixed context so the rendered hunks are stable regardless of the user's
          // diff.context setting.
          `--unified=${DIFF_CONTEXT_LINES}`,
          ...(target === 'staged' ? ['--cached'] : []),
          // `--` separates the pathspec from options, so a file named `--cached` is a
          // filename rather than a flag.
          '--',
          relativePosix,
        ];

        const result = await runner.run(args, { cwd: root });
        if (!result.ok) {
          return result;
        }

        const { exitCode, stdout, stderr } = result.value;
        if (exitCode !== 0) {
          return classifyGitFailure(exitCode, stderr);
        }

        return ok(parseDiff(stdout, { path: relativePosix, target }));
      });
    },
  };
};
