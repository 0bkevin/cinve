import { DataError } from './core.js';

export type FanOutOptions = {
  /** Absolute time after which no new read starts. */
  deadline: number;
  /** A read starts only if this much time remains: one read's worst case. */
  minRemainingMs: number;
  workers: number;
  onStep?: () => void;
};
export type FanOutResult<T> = { done: number; failures: unknown[]; skipped: T[]; stopped?: unknown };

/**
 * Bounded fan-out over one provider. Reads start only while a whole read
 * still fits before the deadline. The provider refusing us (rate limit or
 * anti-bot) stops every worker at once, and so do three consecutive
 * failures (an outage), instead of sending the rest of the queue.
 */
export async function fanOut<T>(work: T[], run: (item: T) => Promise<void>, options: FanOutOptions): Promise<FanOutResult<T>> {
  const failures: unknown[] = [];
  let next = 0, done = 0, consecutive = 0, stopped: unknown;
  const worker = async () => {
    while (next < work.length && stopped === undefined && Date.now() + options.minRemainingMs <= options.deadline) {
      const item = work[next++];
      try {
        await run(item);
        done++; consecutive = 0;
      } catch (error) {
        failures.push(error);
        if (error instanceof DataError && (error.status === 'rate_limited' || error.status === 'blocked')) stopped ??= error;
        else if (++consecutive >= 3) stopped ??= error;
      }
      options.onStep?.();
    }
  };
  await Promise.all(Array.from({ length: Math.min(options.workers, work.length) }, worker));
  return { done, failures, skipped: work.slice(next), stopped };
}
