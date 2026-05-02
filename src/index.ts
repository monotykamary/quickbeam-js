/**
 * beam-otp — OTP patterns in JavaScript, on the BEAM.
 *
 * @module beam-otp
 */

// ── Beam primitives (re-export for convenience) ────────────────────
export {
  Beam,
  getBeam,
  setMockBeam,
} from "./beam-shim.js";
export type {
  BeamPid,
  BeamRef,
  BeamMonitorRef,
  BeamAPI,
  BeamMessageHandler,
  BeamMonitorCallback,
} from "./beam-shim.js";

// ── Errors ─────────────────────────────────────────────────────────
export { BeamOtpError, findCause } from "./errors.js";
export type { BeamOtpErrorTag, BeamOtpErrorCode } from "./errors.js";

// ── Types ──────────────────────────────────────────────────────────
export type {
  ChildSpec,
  ChildInfo,
  SupervisorConfig,
  SupervisorStrategy,
  RestartPolicy,
  From,
  CallResult,
  CastResult,
  InfoResult,
  GenServerConfig,
  RegistryConfig,
  RegistryEntry,
  RegistryKeysMode,
  PoolConfig,
  PoolStatus,
  TaskRef,
  AppConfig,
} from "./types.js";

// ── GenServer ──────────────────────────────────────────────────────
export { GenServer } from "./gen-server.js";

// ── Supervisor — exports both the type and the namespace value ─────
export { Supervisor } from "./supervisor.js";

// ── Registry — exports both the type and the namespace value ───────
export { Registry } from "./registry.js";

// ── Pool — exports both the type and the namespace value ───────────
export { Pool } from "./pool.js";

// ── Task ───────────────────────────────────────────────────────────
export { Task } from "./task.js";

// ── Application — exports both the type and the namespace value ────
export { Application } from "./application.js";

// ── Utilities ──────────────────────────────────────────────────────
export { sleep, retry, withTimeout } from "./utils.js";
