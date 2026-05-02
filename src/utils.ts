/**
 * Utility helpers for quickbeam-js.
 *
 * @module utils
 */

import { Beam } from "./beam-shim.js";
import { BeamOtpError } from "./errors.js";

/**
 * Non-blocking sleep (yields to the BEAM scheduler).
 *
 * @param ms - Milliseconds to wait.
 */
export async function sleep(ms: number): Promise<void> {
  return Beam.sleep(ms);
}

/**
 * Retry an async operation with exponential backoff.
 *
 * @param fn - The operation to retry.
 * @param options - Retry configuration.
 * @returns The result of `fn` on success.
 * @throws The last error if all attempts fail.
 */
export async function retry<T>(
  fn: () => Promise<T>,
  options: {
    maxAttempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    backoffFactor?: number;
    onRetry?: (attempt: number, error: any) => void;
  } = {},
): Promise<T> {
  const {
    maxAttempts = 3,
    baseDelayMs = 100,
    maxDelayMs = 5000,
    backoffFactor = 2,
    onRetry,
  } = options;

  let lastError: any;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        onRetry?.(attempt, err);
        const delay = Math.min(baseDelayMs * Math.pow(backoffFactor, attempt - 1), maxDelayMs);
        await sleep(delay);
      }
    }
  }

  throw lastError;
}

/**
 * Execute an async operation with a timeout. Throws if `fn` doesn't
 * settle within `timeoutMs` milliseconds.
 *
 * @param fn - The operation to run.
 * @param timeoutMs - Deadline in milliseconds.
 * @param label - Human-readable label for the error message.
 * @returns The result of `fn`.
 */
export async function withTimeout<T>(
  fn: () => Promise<T>,
  timeoutMs: number,
  label = "operation",
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new BeamOtpError("BeamOtpError:timeout", `${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    fn()
      .then((result: T) => {
        clearTimeout(timer);
        resolve(result);
      })
      .catch((err: any) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

/**
 * Generate a unique string ID.
 */
export function makeId(prefix = "id"): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Return a promise that resolves after `ms` with the given value.
 */
export function delayed<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/**
 * Sequential async map — runs `fn` on each item in series.
 */
export async function asyncMapSeries<T, U>(
  items: T[],
  fn: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results: U[] = [];
  for (let i = 0; i < items.length; i++) {
    results.push(await fn(items[i], i));
  }
  return results;
}

/**
 * Reverse sequential async map — runs `fn` on each item in reverse series.
 */
export async function asyncMapSeriesReverse<T, U>(
  items: T[],
  fn: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results: U[] = new Array(items.length);
  for (let i = items.length - 1; i >= 0; i--) {
    results[i] = await fn(items[i], i);
  }
  return results;
}
