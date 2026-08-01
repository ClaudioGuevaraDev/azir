import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Every dependency is pinned to an exact version, and this is the mechanism that keeps
 * it that way.
 *
 * A caret turns the installed tree into a function of the date it was installed on. That
 * is a bad trade anywhere, and a worse one here: `README.md`'s standing warning is that
 * packaging can break what dev proves works, so a dependency that moved on its own turns
 * "it worked last week" into a claim nobody can check. `pnpm-lock.yaml` already pins the
 * resolved versions, but a lockfile only helps whoever has it — an install from a bare
 * manifest, or a freshly added package, still resolves through the specifier.
 *
 * Two other things enforce the same rule and neither is sufficient alone: `savePrefix: ''`
 * in `pnpm-workspace.yaml` stops `pnpm add` from writing a range in the first place, and
 * this test catches a range that arrives some other way — a hand edit, a merge, or
 * `pnpm update`, which rewrites the specifier it finds.
 *
 * `engines` is excluded on purpose. Those are runtime floors rather than installs, and
 * `>=` is the correct shape for them.
 */

interface Manifest {
  readonly dependencies?: Record<string, string>;
  readonly devDependencies?: Record<string, string>;
}

const manifestPath = path.resolve(__dirname, '..', 'package.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;

/** `1.2.3`, and prereleases like `1.2.3-rc.1`, but nothing carrying a range operator. */
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

const sections: ReadonlyArray<
  readonly ['dependencies' | 'devDependencies', Record<string, string>]
> = [
  ['dependencies', manifest.dependencies ?? {}],
  ['devDependencies', manifest.devDependencies ?? {}],
];

describe('dependency versions are exact', () => {
  it.each(sections)(
    '%s is not empty, so the assertion below cannot pass vacuously',
    (_, entries) => {
      expect(Object.keys(entries).length).toBeGreaterThan(0);
    },
  );

  it.each(sections)('every %s specifier is an exact version', (section, entries) => {
    const offenders = Object.entries(entries)
      .filter(([, specifier]) => !EXACT.test(specifier))
      .map(([name, specifier]) => `${name}: "${specifier}"`);

    // Named in the failure rather than counted: the point of failing is to say which
    // line to edit.
    expect(offenders, `${section} must pin exact versions`).toEqual([]);
  });
});
