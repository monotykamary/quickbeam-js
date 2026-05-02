/**
 * Shared types for quickbeam-js.
 *
 * @module types
 */

import type { BeamPid, BeamRef } from "./beam-shim.js";

// ── Supervisor ─────────────────────────────────────────────────────

/** Restart policy for supervised children. */
export type RestartPolicy = "permanent" | "temporary" | "transient";

/** Supervisor strategy. */
export type SupervisorStrategy = "one_for_one" | "one_for_all" | "rest_for_one";

/** Specifier for a supervised child. */
export interface ChildSpec {
  /** Unique identifier for this child within the supervisor. */
  id: string;
  /** Function that starts the child process and returns its PID. */
  start: () => Promise<BeamPid>;
  /** Restart policy. Default: `"permanent"`. */
  restart?: RestartPolicy;
  /** Milliseconds to wait for graceful shutdown before killing. Default: 5000. */
  shutdown?: number | "infinity";
  /** Child type. Default: `"worker"`. */
  type?: "worker" | "supervisor";
}

/** Information about a running child. */
export interface ChildInfo {
  id: string;
  pid: BeamPid;
  type: "worker" | "supervisor";
  restart: RestartPolicy;
}

/** Supervisor configuration. */
export interface SupervisorConfig {
  /** Restart strategy. */
  strategy: SupervisorStrategy;
  /** Child specifications to start in order. */
  children: ChildSpec[];
  /** Maximum allowed restarts in the window. Default: 3. */
  max_restarts?: number;
  /** Window (in seconds) for restart counting. Default: 5. */
  max_seconds?: number;
}

// ── GenServer ──────────────────────────────────────────────────────

/** The "from" tuple passed to handleCall — identifies the caller. */
export interface From {
  pid: BeamPid;
  ref: BeamRef;
}

/** Result of a handleCall handler. */
export interface CallResult<T = any> {
  reply: T;
  state: any;
}

/** Result of a handleCast handler. */
export interface CastResult {
  state: any;
}

/** Result of a handleInfo handler. */
export interface InfoResult {
  state: any;
}

/** Configuration for GenServer.startLink. */
export interface GenServerConfig {
  /** Register the GenServer under this name. */
  name?: string;
  /** Arguments passed to init(). */
  args?: any;
  /** Default timeout for GenServer.call in ms. Default: 5000. */
  timeout?: number;
  /** Idle ms before hibernation. Default: Infinity (never). */
  hibernate_after?: number;
}

// ── Registry ───────────────────────────────────────────────────────

/** Registry key mode. */
export type RegistryKeysMode = "unique" | "duplicate";

/** Registry configuration. */
export interface RegistryConfig {
  /** Key uniqueness mode. Default: "unique". */
  keys?: RegistryKeysMode;
}

/** A single registry entry. */
export interface RegistryEntry {
  pid: BeamPid;
  value: any;
}

// ── Pool ───────────────────────────────────────────────────────────

/** Pool configuration. */
export interface PoolConfig {
  /** Name to register the pool under. */
  name: string;
  /** Fixed number of workers. */
  size: number;
  /** GenServer subclass to use as worker. */
  child: any; // typeof GenServer
  /** Arguments passed to each worker's init(). */
  childArgs?: any;
  /** Checkout strategy. Default: "fifo". */
  strategy?: "fifo" | "lifo";
  /** Number of overflow workers allowed beyond `size`. Default: 0. */
  overflow?: number;
  /** Hard cap on overflow. Default: 0. */
  max_overflow?: number;
}

/** Pool status snapshot. */
export interface PoolStatus {
  size: number;
  active: number;
  idle: number;
  overflow: number;
}

// ── Task ───────────────────────────────────────────────────────────

/** Reference to a running task. */
export interface TaskRef<_T = any> {
  pid: BeamPid;
  ref: BeamRef;
  /** Cancel the task (sends shutdown signal). */
  cancel(): void;
}

// ── Application ────────────────────────────────────────────────────

/** Top-level application configuration. */
export interface AppConfig {
  /** Application identifier. */
  id: string;
  /** Root supervisor configuration. */
  supervisor: SupervisorConfig;
  /** Environment key-value pairs accessible via getEnv/putEnv. */
  env?: Record<string, any>;
}

// ── Internal ───────────────────────────────────────────────────────

/** Internal child state tracked by the supervisor. */
export interface ChildState {
  spec: ChildSpec;
  pid: BeamPid | null;
  monitorRef: BeamRef | null;
  restarts: number;
  startTime: number;
}

/** Internal message types for GenServer protocol. */
export interface GenCallMessage {
  type: "call";
  ref: BeamRef;
  from: BeamPid;
  message: any;
}

export interface GenReplyMessage {
  type: "reply";
  ref: BeamRef;
  result: any;
}

export interface GenCastMessage {
  type: "cast";
  message: any;
}

export interface GenExitMessage {
  type: "exit";
  pid: BeamPid;
  reason: any;
}

export interface GenSystemMessage {
  type: "system";
  action: "shutdown" | "code_change";
  payload: any;
}

/** Union of all GenServer protocol messages. */
export type GenMessage =
  | GenCallMessage
  | GenReplyMessage
  | GenCastMessage
  | GenExitMessage
  | GenSystemMessage
  | { type: string; [key: string]: any };
