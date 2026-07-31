import { err, type AppErrorCode, type Result } from '@shared/ipc/result';

/**
 * Turns a failed `git` invocation into one of a closed set of application states.
 *
 * docs/architecture.md lists these explicitly as states rather than crashes: git not
 * installed, folder is not a repository, repository has no commits, command timed
 * out, path no longer exists. Each has a different consequence for the UI — a missing
 * binary disables git for the session, a non-repository is permanent for that folder,
 * a timeout is worth retrying — so the reducer needs to tell them apart without
 * string-matching a message that varies by git version.
 *
 * `LC_ALL=C` is set by the runner precisely so these patterns are stable.
 */
export const classifyGitFailure = (exitCode: number, stderr: string): Result<never> => {
  const message = stderr.toLowerCase();

  if (message.includes('not a git repository')) {
    return err('not-a-repository', 'This folder is not a git repository.', stderr.trim());
  }

  if (
    message.includes('does not have any commits yet') ||
    message.includes('unknown revision or path not in the working tree') ||
    message.includes("ambiguous argument 'head'")
  ) {
    // Reported rather than treated as an error: a fresh repository is a perfectly
    // normal thing to supervise, and every file in it is simply untracked.
    return err('not-a-repository', 'This repository has no commits yet.', stderr.trim());
  }

  if (message.includes('dubious ownership')) {
    return err(
      'permission-denied',
      'git refuses to read this repository because it is owned by another user.',
      stderr.trim(),
    );
  }

  if (message.includes('permission denied')) {
    return err('permission-denied', 'git was denied access to this repository.', stderr.trim());
  }

  if (message.includes('index.lock')) {
    // Another git process holds the lock — usually the user's own command in the
    // integrated terminal. Worth retrying rather than reporting as broken.
    return err(
      'timed-out',
      'The repository is busy; another git process holds the lock.',
      stderr.trim(),
    );
  }

  const code: AppErrorCode = 'internal';
  return err(code, `git exited with code ${exitCode}.`, stderr.trim() || undefined);
};
