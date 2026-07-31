/**
 * A concurrency-limited queue with per-key coalescing.
 *
 * docs/architecture.md refuses a single global queue for all external work: "A slow
 * repository search must never delay terminal input. A slow git command must never
 * delay PTY output." So each domain gets its own scheduler, and PTY traffic gets no
 * scheduler at all — it goes straight through.
 *
 * This one exists for git. Two properties matter:
 *
 *  - **Bounded concurrency.** A watcher batch can ask for a status refresh while a
 *    diff is running and another is queued; spawning a process per request would fork
 *    dozens of `git` executables during an `npm install`.
 *  - **Coalescing by key.** Performance rule 9 asks for deduplicated git refreshes.
 *    If a refresh is already *waiting* to run, a second request for the same key is
 *    the same work and joins it rather than queueing behind it. A request that is
 *    already *running* is not joined: it may have read the tree before the change
 *    that prompted the new request, so the new one has to actually run.
 */

export interface BoundedSchedulerOptions {
  /** How many tasks may run at once. */
  readonly concurrency?: number;
}

export interface BoundedScheduler {
  /**
   * Runs `task`, or joins an identical one that is still queued.
   *
   * Rejections propagate to every caller that joined, so a coalesced failure is not
   * silently swallowed for the second caller.
   */
  run<T>(key: string, task: () => Promise<T>): Promise<T>;
  /** Queued but not yet started. */
  queued(): number;
  running(): number;
}

interface QueueEntry {
  readonly key: string;
  readonly task: () => Promise<unknown>;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
}

const DEFAULT_CONCURRENCY = 2;

export const createBoundedScheduler = (options: BoundedSchedulerOptions = {}): BoundedScheduler => {
  const concurrency = Math.max(1, options.concurrency ?? DEFAULT_CONCURRENCY);

  const queue: QueueEntry[] = [];
  /** Key → the promise of the queued (not yet started) entry for that key. */
  const waiting = new Map<string, Promise<unknown>>();
  let active = 0;

  const pump = (): void => {
    while (active < concurrency && queue.length > 0) {
      const entry = queue.shift();
      if (!entry) {
        break;
      }
      // Removed from `waiting` as it starts: from here on a new request for the same
      // key is genuinely new work, because this one may already have read stale data.
      waiting.delete(entry.key);
      active += 1;

      void (async () => {
        try {
          entry.resolve(await entry.task());
        } catch (error) {
          entry.reject(error);
        } finally {
          active -= 1;
          pump();
        }
      })();
    }
  };

  return {
    run<T>(key: string, task: () => Promise<T>): Promise<T> {
      const joined = waiting.get(key);
      if (joined) {
        return joined as Promise<T>;
      }

      const promise = new Promise<T>((resolve, reject) => {
        queue.push({
          key,
          task: task as () => Promise<unknown>,
          resolve: resolve as (value: unknown) => void,
          reject,
        });
      });

      waiting.set(key, promise);
      // Scheduled before pumping so a synchronous task cannot start before the entry
      // is joinable.
      pump();
      return promise;
    },

    queued: () => queue.length,
    running: () => active,
  };
};
