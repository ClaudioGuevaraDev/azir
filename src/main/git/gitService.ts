import type { GitStatusResponse } from '@shared/ipc/contracts';
import { ok, type Result } from '@shared/ipc/result';
import { createBoundedScheduler, type BoundedScheduler } from '../scheduler/boundedScheduler';
import { classifyGitFailure } from './errors';
import { createGitRunner, type GitRunner } from './gitRunner';
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
  };
};
