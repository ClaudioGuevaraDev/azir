/**
 * Serialises work per key, coalescing what is still waiting.
 *
 * docs/architecture.md states the requirement precisely, and the two halves pull in opposite
 * directions: "Writes must be serialized per path. A newer save for the same path may replace
 * an older pending save, but a save must never be dropped merely because other work is
 * queued."
 *
 * So:
 *
 *  - **One task in flight per key.** Two concurrent writes to the same file can interleave
 *    and produce a mixture of both versions, which is a corrupted file rather than a stale
 *    one.
 *  - **A newer task replaces a waiting one**, because the older content is already obsolete —
 *    writing it and then immediately overwriting it is pure I/O.
 *  - **No caller is ever abandoned.** When a waiting task is replaced, the callers that were
 *    waiting on it are carried over to the replacement and settle with its outcome. Dropping
 *    them would leave a save that silently never resolves, and the UI showing "saving…"
 *    forever.
 *  - **Different keys never block each other.** A slow write to one file must not delay a
 *    save to another.
 */

export interface KeyedSerialQueue<T> {
  /** Runs `task` for `key`, or joins and replaces whatever is waiting for that key. */
  enqueue(key: string, task: () => Promise<T>): Promise<T>;
  /** True while a task for this key is running or waiting. */
  busy(key: string): boolean;
  /** Test seam. */
  size(): number;
}

interface Waiting<T> {
  task: () => Promise<T>;
  /** Every caller that will settle with whatever finally runs for this key. */
  readonly resolvers: Array<(value: T) => void>;
  readonly rejecters: Array<(error: unknown) => void>;
}

export const createKeyedSerialQueue = <T>(): KeyedSerialQueue<T> => {
  const running = new Set<string>();
  const waiting = new Map<string, Waiting<T>>();

  const drain = (key: string): void => {
    const next = waiting.get(key);
    if (!next) {
      running.delete(key);
      return;
    }
    waiting.delete(key);

    void next
      .task()
      .then((value) => {
        for (const resolve of next.resolvers) {
          resolve(value);
        }
      })
      .catch((error: unknown) => {
        for (const reject of next.rejecters) {
          reject(error);
        }
      })
      .finally(() => {
        drain(key);
      });
  };

  return {
    enqueue(key, task) {
      return new Promise<T>((resolve, reject) => {
        const existing = waiting.get(key);
        if (existing) {
          // Replace the work, keep the audience: the newer content supersedes the older, but
          // the caller waiting on the older one still gets an answer.
          existing.task = task;
          existing.resolvers.push(resolve);
          existing.rejecters.push(reject);
          return;
        }

        waiting.set(key, { task, resolvers: [resolve], rejecters: [reject] });

        if (!running.has(key)) {
          running.add(key);
          drain(key);
        }
      });
    },

    busy(key) {
      return running.has(key) || waiting.has(key);
    },

    size() {
      return running.size;
    },
  };
};
