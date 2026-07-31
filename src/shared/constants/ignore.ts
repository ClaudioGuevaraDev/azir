/**
 * The single ignore list, shared by the directory scanner and the filesystem
 * watcher.
 *
 * docs/architecture.md is explicit about why this is one module rather than two
 * lists: "Ignored directories must be shared by the scanner and watcher so they
 * cannot disagree about what exists." If the watcher reports a change under a path
 * the scanner never walks, the tree gets an event for a node that does not exist;
 * if the scanner shows a directory the watcher ignores, its contents silently stop
 * updating. Both bugs are invisible until someone notices the tree is wrong.
 *
 * The entries follow the spec's "typical ignored paths". They are hard-coded for
 * now; M8 makes them a repository setting.
 */

/**
 * Directory names that are never listed and never walked, at any depth.
 *
 * `.git` is here because its contents are plumbing, not the user's work — but the
 * watcher still subscribes to a few specific paths inside it (see
 * `GIT_DIR_TRIGGERS`), because that is how a commit made in the terminal becomes
 * visible in the tree.
 */
export const IGNORED_DIRECTORY_NAMES: ReadonlySet<string> = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.turbo',
  '.venv',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.gradle',
  '.idea',
  'vendor',
]);

/**
 * Paths inside `.git` whose change means the repository state moved: a commit, a
 * checkout, a stage, a branch switch.
 *
 * Deliberately narrow. `.git/objects` churns on every write and carries no
 * information the tree can use — watching it would produce thousands of events per
 * commit and tell us nothing that `HEAD` and `index` do not.
 */
export const GIT_DIR_TRIGGERS: readonly string[] = [
  '.git/HEAD',
  '.git/index',
  '.git/MERGE_HEAD',
  '.git/refs',
  '.git/packed-refs',
];

/** True when a workspace-relative POSIX path lies inside an ignored directory. */
export const isIgnoredPath = (relativePosix: string): boolean => {
  if (relativePosix === '') {
    return false;
  }
  for (const segment of relativePosix.split('/')) {
    if (IGNORED_DIRECTORY_NAMES.has(segment)) {
      return true;
    }
  }
  return false;
};

/** True when a `.git`-relative change should trigger a git refresh. */
export const isGitStateChange = (relativePosix: string): boolean =>
  GIT_DIR_TRIGGERS.some(
    (trigger) => relativePosix === trigger || relativePosix.startsWith(`${trigger}/`),
  );
