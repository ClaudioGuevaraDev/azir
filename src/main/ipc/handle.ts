import { ipcMain } from 'electron';
import type { ZodType } from 'zod';
import { describeError, err, ok, type Result } from '@shared/ipc/result';

/**
 * Register a request/response handler whose contract is total.
 *
 * Two things happen here that must happen for *every* channel, which is why
 * handlers are never registered with `ipcMain.handle` directly:
 *
 *  1. The payload is validated before the handler sees it. Everything arriving
 *     from the renderer is untrusted (docs/architecture.md, Security).
 *  2. Nothing escapes as a rejection. A thrown exception becomes an
 *     `internal` error, so the renderer's effect runner has exactly one shape
 *     to deal with and a bug in one subsystem cannot surface as an unhandled
 *     promise rejection.
 */
export const handle = <Request, Response>(
  channel: string,
  schema: ZodType<Request>,
  handler: (request: Request) => Promise<Response> | Response,
): void => {
  ipcMain.handle(channel, async (_event, raw: unknown): Promise<Result<Response>> => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return err('invalid-request', `Invalid payload for ${channel}.`, parsed.error.message);
    }

    try {
      return ok(await handler(parsed.data));
    } catch (error) {
      // Logged as well as returned: the renderer shows the message, but the
      // stack belongs in the main-process log where it is not truncated.
      console.error(`[ipc] ${channel} threw:`, error);
      return err('internal', `${channel} failed unexpectedly.`, describeError(error));
    }
  });
};

/**
 * Fire-and-forget commands: no reply, and the sender does not wait.
 *
 * Used for PTY keystrokes and resizes. Those are latency-sensitive and produce no
 * value the caller needs — a round trip per character typed would make the
 * integrated terminal feel worse than the shell it hosts
 * (docs/architecture.md: "PTY traffic never waits behind git, search or filesystem
 * scans").
 *
 * Validation and the never-throw guarantee still apply. Because there is no
 * channel back, a rejected payload can only be logged; the alternative — throwing
 * inside an `ipcMain.on` listener — would surface as an unhandled exception in the
 * main process.
 */
export const listen = <Request>(
  channel: string,
  schema: ZodType<Request>,
  handler: (request: Request) => void,
): void => {
  ipcMain.on(channel, (_event, raw: unknown) => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      console.error(`[ipc] ${channel} rejected an invalid payload:`, parsed.error.message);
      return;
    }

    try {
      handler(parsed.data);
    } catch (error) {
      console.error(`[ipc] ${channel} threw:`, error);
    }
  });
};

/**
 * A handler that is expected to fail in ordinary use returns its own Result
 * instead of throwing. This variant passes it through untouched while still
 * validating the request and still catching genuine bugs.
 */
export const handleResult = <Request, Response>(
  channel: string,
  schema: ZodType<Request>,
  handler: (request: Request) => Promise<Result<Response>> | Result<Response>,
): void => {
  ipcMain.handle(channel, async (_event, raw: unknown): Promise<Result<Response>> => {
    const parsed = schema.safeParse(raw);
    if (!parsed.success) {
      return err('invalid-request', `Invalid payload for ${channel}.`, parsed.error.message);
    }

    try {
      return await handler(parsed.data);
    } catch (error) {
      console.error(`[ipc] ${channel} threw:`, error);
      return err('internal', `${channel} failed unexpectedly.`, describeError(error));
    }
  });
};
