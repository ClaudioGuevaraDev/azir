import type { GitChangeKind, GitFileStatus } from '@shared/ipc/contracts';

/**
 * The one-character marks git users already know: `M`, `A`, `D`, `R`, `?`, `U`.
 *
 * Reusing the vocabulary of `git status` rather than inventing icons matters for a
 * supervision tool — the user is switching between this panel and the integrated
 * terminal constantly, and two different notations for the same fact is friction on
 * every glance.
 */
const MARKS: Readonly<Record<GitChangeKind, string>> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  'type-changed': 'T',
  untracked: '?',
  ignored: 'I',
};

export interface GitBadge {
  readonly mark: string;
  /** Drives the colour token, so the palette stays in one place. */
  readonly tone: 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked' | 'conflict';
  readonly label: string;
  /** True when the change is only in the index — rendered dimmer. */
  readonly stagedOnly: boolean;
}

const TONES: Readonly<Record<GitChangeKind, GitBadge['tone']>> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
  renamed: 'renamed',
  copied: 'renamed',
  'type-changed': 'modified',
  untracked: 'untracked',
  ignored: 'untracked',
};

const DESCRIPTIONS: Readonly<Record<GitChangeKind, string>> = {
  added: 'added',
  modified: 'modified',
  deleted: 'deleted',
  renamed: 'renamed',
  copied: 'copied',
  'type-changed': 'type changed',
  untracked: 'untracked',
  ignored: 'ignored',
};

export const gitBadgeOf = (status: GitFileStatus | undefined): GitBadge | null => {
  if (!status) {
    return null;
  }

  if (status.conflicted) {
    return { mark: 'U', tone: 'conflict', label: 'unmerged — needs a decision', stagedOnly: false };
  }

  // The working tree wins when a file is changed on both sides: it is the newer of
  // the two, and it is what the user is about to review.
  const kind = status.unstaged ?? status.staged;
  if (!kind) {
    return null;
  }

  const suffix =
    status.originalPath !== undefined && status.originalPath !== ''
      ? ` from ${status.originalPath}`
      : '';

  return {
    mark: MARKS[kind],
    tone: TONES[kind],
    label: `${DESCRIPTIONS[kind]}${suffix}`,
    stagedOnly: status.unstaged === null && status.staged !== null,
  };
};
