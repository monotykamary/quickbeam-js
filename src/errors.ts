/**
 * Structured error hierarchy for quickbeam-js — following the errore pattern:
 *
 * - Errors-as-values returned as union types (`T | BeamOtpError`)
 * - `_tag` property for type-level discrimination
 * - `cause` for error chaining (Go-style `%w` equivalent)
 * - `findCause()` for walking the cause chain (Go-style `errors.As`)
 * - Never uses `unknown | Error` (collapses to `unknown`)
 *
 * @module errors
 */

/**
 * @deprecated Use `BeamOtpErrorTag` instead.
 * Kept for backward compatibility with code using `err.code` checks.
 */
export type BeamOtpErrorCode = BeamOtpErrorTag;

/**
 * Tag type for discriminating error kinds at the type level.
 *
 * Using string literal unions means TypeScript can narrow within
 * `if (err._tag === "BeamOtpError:timeout")` blocks.
 */
export type BeamOtpErrorTag =
  | "BeamOtpError:timeout"
  | "BeamOtpError:exit"
  | "BeamOtpError:noproc"
  | "BeamOtpError:already_started"
  | "BeamOtpError:not_found"
  | "BeamOtpError:shutdown"
  | "BeamOtpError:restart_limit";

/**
 * Structured error thrown by all quickbeam-js operations.
 *
 * Follows the errore pattern:
 * - **`_tag`** — string literal for type narrowing (primary discriminant)
 * - **`cause`** — chained original error (Go `%w` equivalent)
 * - **`findCause()`** — walk the cause chain (Go `errors.As` equivalent)
 * - **`code`** — deprecated alias for `_tag`, kept for backward compatibility
 * - **`reason`** — deprecated alias for `cause`, kept for backward compatibility
 *
 * @example
 * ```ts
 * const result: User | BeamOtpError = await getUser(id);
 * if (result instanceof BeamOtpError) {
 *   // Narrow by _tag
 *   if (result._tag === "BeamOtpError:not_found") {
 *     console.log("Not found:", result.message);
 *   }
 *   // Walk nested causes
 *   const dbErr = result.findCause(DbError);
 *   if (dbErr) console.log("Root cause:", dbErr.message);
 *   return;
 * }
 * console.log(result.name); // result is User
 * ```
 */
export class BeamOtpError extends Error {
  /** Tag for type-level error discrimination. */
  public readonly _tag: BeamOtpErrorTag;

  /**
   * Optional additional detail (exit reason, stack, etc.).
   *
   * @deprecated Prefer chaining the original error via `cause` (native Error property)
   *              and use `findCause()` to walk the chain.
   */
  public readonly reason?: any;

  /**
   * Create a new quickbeam-js error.
   *
   * @param tag - Discriminant tag for narrowing.
   * @param message - Human-readable message.
   * @param options - Optional chaining and detail.
   * @param options.cause - Chain a causing error (Go `%w` equivalent).
   *                        Sets the native `Error.cause` property.
   * @param options.reason - Legacy detail. Consider using `cause` instead.
   */
  constructor(
    tag: BeamOtpErrorTag,
    message: string,
    options?: { cause?: Error; reason?: any },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "BeamOtpError";
    this._tag = tag;
    this.reason = options?.reason;
  }

  // ── Backward-compatible accessors ────────────────────────────────

  /**
   * Machine-readable error code.
   *
   * @deprecated Use `_tag` instead. This accessor extracts the suffix
   *             from `_tag` (e.g. `"timeout"` from `"BeamOtpError:timeout"`).
   *             Kept for backward compatibility with existing `err.code` checks.
   */
  get code(): string {
    return this._tag.replace("BeamOtpError:", "");
  }

  // ── errore pattern: findCause ────────────────────────────────────

  /**
   * Walk the cause chain to find an ancestor matching a specific error class.
   *
   * Equivalent to Go's `errors.As`. Checks `this` first, then traverses
   * `this.cause` recursively. TypeScript infers the return type from the
   * constructor argument.
   *
   * @param errorClass - Constructor of the error type to find.
   * @returns The matched error with full type inference, or `undefined`.
   *
   * @example
   * ```ts
   * const dbErr = svcErr.findCause(DbError);
   * dbErr?.host; // type-safe access
   * ```
   */
  findCause<T extends Error>(
    errorClass: new (...args: any[]) => T,
  ): T | undefined {
    // Check self
    if (this instanceof errorClass) {
      return this as unknown as T;
    }

    // Walk cause chain
    let current: Error | undefined = this.cause as Error | undefined;
    const visited = new Set<Error>();
    while (current && !visited.has(current)) {
      visited.add(current);
      if (current instanceof errorClass) {
        return current;
      }
      current = current.cause as Error | undefined;
    }

    return undefined;
  }

  // ── Factory methods ──────────────────────────────────────────────

  /** Create a timeout error. */
  static timeout(operation: string, ms: number, cause?: Error): BeamOtpError {
    return new BeamOtpError(
      "BeamOtpError:timeout",
      `${operation} timed out after ${ms}ms`,
      { cause },
    );
  }

  /** Create an exit error (target process exited). */
  static exit(target: string, reason: any, cause?: Error): BeamOtpError {
    return new BeamOtpError(
      "BeamOtpError:exit",
      `Process ${target} exited`,
      { cause, reason },
    );
  }

  /** Create a noproc error (no process registered). */
  static noproc(name: string, cause?: Error): BeamOtpError {
    return new BeamOtpError(
      "BeamOtpError:noproc",
      `No process registered under '${name}'`,
      { cause },
    );
  }

  /** Create an already-started error. */
  static alreadyStarted(name: string, cause?: Error): BeamOtpError {
    return new BeamOtpError(
      "BeamOtpError:already_started",
      `Name '${name}' is already registered`,
      { cause },
    );
  }

  /** Create a not-found error. */
  static notFound(what: string, id: string, cause?: Error): BeamOtpError {
    return new BeamOtpError(
      "BeamOtpError:not_found",
      `${what} '${id}' not found`,
      { cause },
    );
  }

  /** Create a shutdown error. */
  static shutdown(reason?: any, cause?: Error): BeamOtpError {
    return new BeamOtpError(
      "BeamOtpError:shutdown",
      "Supervisor is shutting down",
      { cause, reason },
    );
  }

  /** Create a restart-limit error. */
  static restartLimit(
    maxR: number,
    maxS: number,
    cause?: Error,
  ): BeamOtpError {
    return new BeamOtpError(
      "BeamOtpError:restart_limit",
      `Reached max restart intensity (${maxR} restarts in ${maxS}s)`,
      { cause },
    );
  }
}

/**
 * Standalone `findCause` that works on any Error.
 *
 * Equivalent to Go's `errors.As`. Checks the error itself first, then
 * traverses `.cause` recursively. Safe against circular references.
 *
 * @param err - The error to search.
 * @param errorClass - Constructor of the error type to find.
 * @returns The matched error with full type inference, or `undefined`.
 *
 * @example
 * ```ts
 * import { findCause } from "quickbeam-js";
 * const dbErr = findCause(wrapped, DbError);
 * ```
 */
export function findCause<T extends Error>(
  err: Error,
  errorClass: new (...args: any[]) => T,
): T | undefined {
  if (err instanceof errorClass) {
    return err;
  }
  // Walk cause chain
  let current: Error | undefined = err.cause as Error | undefined;
  const visited = new Set<Error>();
  while (current && !visited.has(current)) {
    visited.add(current);
    if (current instanceof errorClass) {
      return current;
    }
    current = current.cause as Error | undefined;
  }
  return undefined;
}
