import { createDialogService, type DialogService } from './dialogs';
import { createSessionRegistry, type SessionRegistry } from '../workspace/sessions';

/**
 * The main process's services, assembled in one place and passed down.
 *
 * Deliberately not module-level singletons: docs/architecture.md's testing
 * strategy calls for main-process unit tests that mock the system boundaries,
 * and that is only possible if the thing under test receives its dependencies
 * rather than importing them.
 */
export interface AppContext {
  readonly sessions: SessionRegistry;
  readonly dialogs: DialogService;
}

export type AppContextOverrides = Partial<AppContext>;

export const createAppContext = (overrides: AppContextOverrides = {}): AppContext => ({
  sessions: overrides.sessions ?? createSessionRegistry(),
  dialogs: overrides.dialogs ?? createDialogService(),
});
