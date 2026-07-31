import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// React Testing Library only auto-registers its cleanup when Vitest runs with
// globals enabled. We run without them (explicit imports keep the boundary
// between test and source obvious), so unmounting has to be wired up by hand —
// otherwise every render leaks into the next test's document and queries that
// expect one match start finding several.
afterEach(() => {
  cleanup();
});
