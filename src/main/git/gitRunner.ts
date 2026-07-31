import { spawn } from 'node:child_process';
import { describeError, err, ok, type Result } from '@shared/ipc/result';

/**
 * Runs the system `git` binary.
 *
 * docs/architecture.md is emphatic that Azir does not reimplement git semantics: the
 * real binary gives exact `.gitignore` behaviour, worktrees, submodules and the
 * user's own configuration, and it keeps the app's view of the repository identical
 * to what the user sees in the integrated terminal.
 *
 * Everything about how it is invoked is a safety property:
 *
 *  - **`shell: false` and an argument array.** The spec shows the exact anti-pattern
 *    to avoid — interpolating a path into a command string. A file called
 *    `$(rm -rf ~).ts` is a legal filename.
 *  - **Piped stdio, never inherited.** Inheriting would attach git to the app's own
 *    streams; in a packaged Windows app those may not exist, and a prompt would hang
 *    forever with nowhere to display.
 *  - **A hard timeout.** A repository on a disconnected network share makes git block
 *    indefinitely. The spec lists "command timed out" as an application state.
 *  - **No interactive prompts.** `GIT_TERMINAL_PROMPT=0` turns a credential prompt
 *    into an error instead of a process waiting for input nobody can give.
 */

export interface GitRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface GitRunOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
}

export interface GitRunner {
  /** Resolves with the process outcome; a non-zero exit is a value, not a failure. */
  run(args: readonly string[], options: GitRunOptions): Promise<Result<GitRunResult>>;
}

export interface GitRunnerOptions {
  readonly gitPath?: string;
  readonly defaultTimeoutMs?: number;
  /** Injected in tests so no real process is spawned. */
  readonly spawnProcess?: typeof spawn;
}

/**
 * Prepended to every invocation.
 *
 * `--no-optional-locks` keeps a background status from taking `index.lock` and
 * making the user's own git commands fail — the app is a spectator and must not
 * interfere with the terminal it sits next to. `--no-pager` matters because a
 * configured pager would otherwise wait for a terminal that does not exist.
 */
const GLOBAL_ARGS: readonly string[] = [
  '--no-optional-locks',
  '--no-pager',
  // Paths come back raw rather than C-quoted, which is what the -z parsers expect.
  '-c',
  'core.quotepath=false',
];

const DEFAULT_TIMEOUT_MS = 10_000;

export const createGitRunner = (options: GitRunnerOptions = {}): GitRunner => {
  const gitPath = options.gitPath ?? 'git';
  const defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const spawnProcess = options.spawnProcess ?? spawn;

  return {
    run(args, runOptions) {
      const timeoutMs = runOptions.timeoutMs ?? defaultTimeoutMs;

      return new Promise<Result<GitRunResult>>((resolve) => {
        let settled = false;
        const settle = (result: Result<GitRunResult>): void => {
          if (settled) {
            return;
          }
          settled = true;
          resolve(result);
        };

        let child;
        try {
          child = spawnProcess(gitPath, [...GLOBAL_ARGS, ...args], {
            cwd: runOptions.cwd,
            shell: false,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
            env: {
              ...process.env,
              // A credential prompt with no terminal would block until the timeout.
              GIT_TERMINAL_PROMPT: '0',
              // Locale-independent messages, so error classification is stable.
              LC_ALL: 'C',
            },
          });
        } catch (error) {
          settle(err('git-missing', 'git could not be started.', describeError(error)));
          return;
        }

        // Buffers rather than strings: a chunk boundary can fall inside a multi-byte
        // character, and decoding per chunk would corrupt non-ASCII paths.
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];

        const timer = setTimeout(() => {
          child.kill();
          settle(err('timed-out', `git ${args[0] ?? ''} timed out after ${timeoutMs}ms.`));
        }, timeoutMs);

        child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));

        child.on('error', (error: NodeJS.ErrnoException) => {
          clearTimeout(timer);
          if (error.code === 'ENOENT') {
            settle(
              err('git-missing', 'git is not installed, or not on PATH.', describeError(error)),
            );
            return;
          }
          settle(err('internal', 'git could not be started.', describeError(error)));
        });

        child.on('close', (code) => {
          clearTimeout(timer);
          settle(
            ok({
              stdout: Buffer.concat(stdout).toString('utf8'),
              stderr: Buffer.concat(stderr).toString('utf8'),
              // A signalled process reports a null code; -1 marks it as abnormal
              // without pretending it succeeded.
              exitCode: code ?? -1,
            }),
          );
        });
      });
    },
  };
};
