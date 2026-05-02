/**
 * Thin re-export of QuickBEAM's Beam API, matching the real quickbeam.d.ts.
 *
 * In a live QuickBEAM runtime, `Beam` is a global with these exact types.
 * This module re-exports + allows mocking for unit tests.
 *
 * @module beam-shim
 */

/**
 * Opaque BEAM process identifier.
 * Real QuickBEAM: `{ __beam_type__: "pid", __beam_data__: Uint8Array }`.
 * Mock: `{ __beam_type__: "pid", id: number }`.
 */
export type BeamPid = {
  readonly __beam_type__: "pid";
};

/**
 * Opaque BEAM reference (used for call/reply matching and monitors).
 * Real QuickBEAM: `{ __beam_type__: "ref", __beam_data__: Uint8Array }`.
 * Mock: `{ __beam_type__: "ref", id: number }`.
 */
export type BeamRef = {
  readonly __beam_type__: "ref";
};

/**
 * A message handler callback registered via `Beam.onMessage()`.
 * In QuickBEAM the callback signature is `(message: unknown) => void`.
 */
export type BeamMessageHandler = (message: any) => void;

/**
 * Monitor callback invoked when a monitored process exits.
 * In real QuickBEAM the callback receives ONLY the exit reason (no pid).
 */
export type BeamMonitorCallback = (reason: any) => void;

// ── Interface (exact match to quickbeam.d.ts) ──────────────────────

export interface BeamAPI {
  /** Call a named BEAM handler (async). */
  call(handler: string, ...args: unknown[]): Promise<unknown>;

  /** Call a named BEAM handler (synchronous). */
  callSync(handler: string, ...args: unknown[]): unknown;

  /** Send a message to a BEAM process. Fire-and-forget. */
  send(pid: BeamPid, message: unknown): void;

  /** Get the PID of the owning GenServer process. */
  self(): BeamPid;

  /** Register a callback for incoming BEAM messages. */
  onMessage(callback: BeamMessageHandler): void;

  /** Monitor a BEAM process. Callback fires with exit reason when it dies. */
  monitor(pid: BeamPid, callback: BeamMonitorCallback): BeamRef;

  /** Cancel a monitor. */
  demonitor(ref: BeamRef): void;

  /** Returns a Promise that resolves after `ms` milliseconds. */
  sleep(ms: number): Promise<void>;

  /** Spawn a new JS runtime (BEAM process) that evaluates the given script. */
  spawn(script: string): BeamPid;

  /** Register the runtime under a name for discovery. */
  register(name: string): boolean;

  /** Look up a registered runtime by name. Returns PID or null. */
  whereis(name: string): BeamPid | null;

  /** Create a bidirectional link with another BEAM process. */
  link(pid: BeamPid): boolean;

  /** Remove a bidirectional link. */
  unlink(pid: BeamPid): boolean;

  /** Create a unique BEAM reference. */
  makeRef(): BeamRef;

  /** List connected BEAM nodes (including self). */
  nodes(): string[];

  /** QuickBEAM version string. */
  readonly version?: string;

  /** Fast non-cryptographic hash. */
  hash?(data: unknown, range?: number): number;

  /** Escape HTML entities. */
  escapeHTML?(str: string): string;

  /** Generate a UUIDv7. */
  randomUUIDv7?(): string;

  /** Deep structural equality. */
  deepEquals?(a: unknown, b: unknown): boolean;

  /** System info: schedulers, memory, etc. */
  systemInfo?(): Record<string, unknown>;

  /** Process info: memory, reductions, queue. */
  processInfo?(): Record<string, unknown> | null;

  /** Non-blocking sleep (synonym for sleep). */
  sleepSync?(ms: number): void;
}

// ── Implementation ─────────────────────────────────────────────────

let _beam: BeamAPI | null = null;

export function getBeam(): BeamAPI {
  if (_beam) return _beam;
  if (typeof globalThis !== "undefined" && (globalThis as any).Beam) {
    return (globalThis as any).Beam as BeamAPI;
  }
  throw new Error(
    "Beam API not available. Are you running inside a QuickBEAM runtime? " +
    "For testing, call setMockBeam() first."
  );
}

export function setMockBeam(mock: BeamAPI | null): void {
  _beam = mock;
}

// ── Convenience re-exports ─────────────────────────────────────────

export const Beam: BeamAPI = new Proxy({} as BeamAPI, {
  get(_target, prop: string) {
    const b = getBeam();
    const val = (b as any)[prop];
    if (typeof val === "function") return val.bind(b);
    return val;
  },
});
