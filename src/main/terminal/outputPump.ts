/**
 * Batches PTY output before it crosses the IPC boundary.
 *
 * A shell producing output emits many small chunks — `npm install` or a build log
 * can be thousands per second. Each one crossing IPC separately costs a
 * structured clone plus a hop, and arrives as a separate task in the renderer.
 * docs/architecture.md calls for exactly this ("Terminal output should be buffered
 * briefly and written to xterm.js in batches when bursts are large").
 *
 * Two triggers, because either alone has a bad failure mode:
 *  - a short timer, so a single character from an interactive prompt is never
 *    left waiting;
 *  - a size threshold, so a flood is forwarded promptly rather than accumulating
 *    in main's heap for the whole interval.
 */

export interface OutputPumpOptions {
  /** Maximum time a byte waits before being sent. Latency vs. batch size. */
  readonly flushIntervalMs?: number;
  /** Flush immediately once this many characters are buffered. */
  readonly maxBufferedChars?: number;
  /** Injected in tests so flushing can be driven by a fake clock. */
  readonly schedule?: (callback: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly cancel?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface OutputPump {
  push(data: string): void;
  /** Sends anything buffered right now. Safe to call when empty. */
  flush(): void;
  /** Flushes, then refuses further input. Idempotent. */
  dispose(): void;
}

/**
 * 8 ms is roughly half a 60 Hz frame: short enough that typing feels immediate,
 * long enough to coalesce the burst that follows a newline.
 */
const DEFAULT_FLUSH_INTERVAL_MS = 8;
const DEFAULT_MAX_BUFFERED_CHARS = 64 * 1024;

export const createOutputPump = (
  emit: (data: string) => void,
  options: OutputPumpOptions = {},
): OutputPump => {
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxBufferedChars = options.maxBufferedChars ?? DEFAULT_MAX_BUFFERED_CHARS;
  const schedule = options.schedule ?? setTimeout;
  const cancel = options.cancel ?? clearTimeout;

  // An array of chunks rather than string concatenation: repeatedly appending to
  // a growing string is quadratic, and a build log is exactly the case that hurts.
  let chunks: string[] = [];
  let bufferedChars = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const flush = (): void => {
    if (timer !== undefined) {
      cancel(timer);
      timer = undefined;
    }
    if (chunks.length === 0) {
      return;
    }
    const payload = chunks.join('');
    chunks = [];
    bufferedChars = 0;
    emit(payload);
  };

  return {
    push(data) {
      if (disposed || data === '') {
        return;
      }

      chunks.push(data);
      bufferedChars += data.length;

      if (bufferedChars >= maxBufferedChars) {
        flush();
        return;
      }

      timer ??= schedule(flush, flushIntervalMs);
    },

    flush,

    dispose() {
      if (disposed) {
        return;
      }
      // Flushed before closing so the last line of a command's output — often the
      // exit status the user is waiting for — is not dropped.
      flush();
      disposed = true;
    },
  };
};
