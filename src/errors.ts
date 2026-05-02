/**
 * Structured error hierarchy for beam-otp.
 *
 * All runtime errors thrown by beam-otp are `BeamOtpError` instances
 * with a machine-readable `code` and an optional `reason`.
 *
 * @module errors
 */

/**
 * Error codes for beam-otp failures.
 */
export type BeamOtpErrorCode =
  | "timeout"
  | "exit"
  | "noproc"
  | "already_started"
  | "not_found"
  | "shutdown"
  | "restart_limit";

/**
 * Structured error thrown by all beam-otp operations.
 *
 * @example
 * throw new BeamOtpError("timeout", "GenServer.call to 'counter' timed out after 5000ms");
 */
export class BeamOtpError extends Error {
  /** Machine-readable error code. */
  public readonly code: BeamOtpErrorCode;

  /** Optional detail (exit reason, stack, etc.). */
  public readonly reason?: any;

  constructor(code: BeamOtpErrorCode, message: string, reason?: any) {
    super(message);
    this.name = "BeamOtpError";
    this.code = code;
    this.reason = reason;
  }

  /** Create a timeout error. */
  static timeout(operation: string, ms: number): BeamOtpError {
    return new BeamOtpError("timeout", `${operation} timed out after ${ms}ms`);
  }

  /** Create an exit error (target process exited). */
  static exit(target: string, reason: any): BeamOtpError {
    return new BeamOtpError(
      "exit",
      `Process ${target} exited`,
      reason,
    );
  }

  /** Create a noproc error (no process registered). */
  static noproc(name: string): BeamOtpError {
    return new BeamOtpError("noproc", `No process registered under '${name}'`);
  }

  /** Create an already-started error. */
  static alreadyStarted(name: string): BeamOtpError {
    return new BeamOtpError("already_started", `Name '${name}' is already registered`);
  }

  /** Create a not-found error. */
  static notFound(what: string, id: string): BeamOtpError {
    return new BeamOtpError("not_found", `${what} '${id}' not found`);
  }

  /** Create a shutdown error. */
  static shutdown(reason?: any): BeamOtpError {
    return new BeamOtpError("shutdown", "Supervisor is shutting down", reason);
  }

  /** Create a restart-limit error. */
  static restartLimit(maxR: number, maxS: number): BeamOtpError {
    return new BeamOtpError(
      "restart_limit",
      `Reached max restart intensity (${maxR} restarts in ${maxS}s)`,
    );
  }
}
