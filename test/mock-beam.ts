/**
 * Mock Beam API for unit testing quickbeam-js modules.
 *
 * Accurately simulates QuickBEAM's real API:
 * - PIDs are opaque objects (not strings)
 * - Refs are opaque objects
 * - spawn() takes a script string, not a function
 * - register() takes only a name (registers self)
 * - monitor() callback receives only exit reason (not pid)
 * - No exit()/exitProcess() — processes exit by throwing
 *
 * For convenience in tests, provide spawnFn() that wraps spawn + eval.
 *
 * @module test/mock-beam
 */

import { setMockBeam } from "../src/beam-shim.js";
import type {
  BeamAPI,
  BeamPid,
  BeamRef,
  BeamMessageHandler,
  BeamMonitorCallback,
} from "../src/beam-shim.js";

// ── Internal state ─────────────────────────────────────────────────

let pidCounter = 1;
let refCounter = 1;

function makePid(): BeamPid {
  return { __beam_type__: "pid", id: pidCounter++ } as unknown as BeamPid;
}

function makeRef(): BeamRef {
  return { __beam_type__: "ref", id: refCounter++ } as unknown as BeamRef;
}

/** Map<pid, { handler, inbox }> */
const processes = new Map<
  BeamPid,
  {
    handler: BeamMessageHandler | null;
    inbox: any[];
  }
>();

/** Map<name, pid> for registered processes. */
const registry = new Map<string, BeamPid>();

/** Map<ref, { targetPid, callback }> */
const monitors = new Map<
  BeamRef,
  {
    targetPid: BeamPid;
    callback: BeamMonitorCallback;
  }
>();

/** Current "self" — set per-test, changes during message delivery. */
let currentPid: BeamPid = makePid();

// ── Helpers ────────────────────────────────────────────────────────

function pidKey(pid: BeamPid): string {
  return (pid as any).__beam_type__ + ":" + (pid as any).id;
}

function isPidLike(obj: any): obj is BeamPid {
  return obj && typeof obj === "object" && obj.__beam_type__ === "pid";
}

function pidEquals(a: BeamPid, b: BeamPid): boolean {
  return pidKey(a) === pidKey(b);
}

function deliverMessage(pid: BeamPid, msg: any): void {
  const proc = processes.get(pid);
  if (!proc) return; // process doesn't exist — drop

  // Check global reply handlers first (used by GenServer.call)
  if (msg && msg.type === "reply" && msg.ref) {
    const replyHandlers = (globalThis as any).__quickbeam_js_reply_handlers as Map<string, (reply: any) => void> | undefined;
    if (replyHandlers) {
      const key = pidKey(msg.ref);
      if (replyHandlers.has(key)) {
        const handler = replyHandlers.get(key)!;
        handler(msg);
        return;
      }
    }
  }

  if (proc.handler) {
    const prevPid = currentPid;
    currentPid = pid;
    try {
      const result = proc.handler(msg);
      // If the handler returns a Promise that rejects, treat it as exit
      if (result && typeof (result as any).catch === "function") {
        (result as Promise<any>).catch((err: any) => {
          handleProcessExit(pid, err);
        });
      }
    } catch (err) {
      handleProcessExit(pid, err);
    } finally {
      currentPid = prevPid;
    }
  } else {
    proc.inbox.push(msg);
  }
}

function handleProcessExit(pid: BeamPid, reason: any): void {
  // Clean up registrations FIRST
  const namesToDelete: string[] = [];
  for (const [name, registeredPid] of registry) {
    if (pidEquals(registeredPid, pid)) namesToDelete.push(name);
  }
  for (const name of namesToDelete) {
    registry.delete(name);
  }
  // Reset process handler
  const proc = processes.get(pid);
  if (proc) {
    proc.handler = null;
  }

  // Fire monitors (after cleanup)
  const toFire: Array<{ reason: any; callback: BeamMonitorCallback }> = [];
  for (const [monRef, mon] of monitors) {
    if (pidEquals(mon.targetPid, pid)) {
      toFire.push({ reason, callback: mon.callback });
      monitors.delete(monRef);
    }
  }
  const prevPid = currentPid;
  for (const { reason: exitReason, callback } of toFire) {
    try {
      callback(exitReason);
    } catch (_) {
      // Monitor callback errors are swallowed
    }
  }
  currentPid = prevPid;
}

/** Evaluate a script string in the current process context. */
function evalScript(script: string): any {
  const fn = new Function("Beam", script);
  return fn(getBeam());
}

// ── Mock Beam API ──────────────────────────────────────────────────

let beamFn: BeamAPI;

function getBeam(): BeamAPI {
  if (!beamFn) beamFn = buildMockBeam();
  return beamFn;
}

function buildMockBeam(): BeamAPI {
  return {
    async call(_handler: string, ..._args: unknown[]): Promise<unknown> {
      return undefined;
    },

    callSync(_handler: string, ..._args: unknown[]): unknown {
      return undefined;
    },

    send(pid: BeamPid, message: unknown): void {
      deliverMessage(pid, message);
    },

    self(): BeamPid {
      return currentPid;
    },

    onMessage(handler: BeamMessageHandler): void {
      const pid = currentPid;
      const proc = processes.get(pid);
      if (!proc) {
        processes.set(pid, { handler, inbox: [] });
      } else {
        proc.handler = handler;
        while (proc.inbox.length > 0) {
          const msg = proc.inbox.shift()!;
          handler(msg);
        }
      }
    },

    monitor(pid: BeamPid, cb: BeamMonitorCallback): BeamRef {
      const ref = makeRef();
      monitors.set(ref, { targetPid: pid, callback: cb });
      return ref;
    },

    demonitor(ref: BeamRef): void {
      monitors.delete(ref);
    },

    sleep(ms: number): Promise<void> {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },

    /**
     * Spawn a new process by evaluating a script string.
     * The script runs in the new process's context with `Beam` available.
     */
    /**
     * Spawn a new process. Accepts a script string (real QuickBEAM API)
     * OR a function (mock convenience for GenServer.startLink).
     */
    spawn(script: string | ((() => Promise<void> | void))): BeamPid {
      if (typeof script === "function") {
        // Mock convenience: spawn with closure
        const pid = makePid();
        processes.set(pid, { handler: null, inbox: [] });
        const prevPid = currentPid;
        currentPid = pid;
        const fn = script;
        (async () => {
          try {
            await fn();
          } catch (err) {
            handleProcessExit(pid, err);
          } finally {
            currentPid = prevPid;
          }
        })();
        return pid;
      }
      // Script string (real QuickBEAM API)
      const pid = makePid();
      processes.set(pid, { handler: null, inbox: [] });
      const prevPid = currentPid;
      currentPid = pid;
      try {
        evalScript(script);
      } catch (err) {
        handleProcessExit(pid, err);
      } finally {
        currentPid = prevPid;
      }
      return pid;
    },

    // Internal: spawn with a function (for mock testing only, not part of real API)
    _spawnFn: (undefined as any),

    register(name: string): boolean {
      if (registry.has(name)) return false;
      registry.set(name, currentPid);
      return true;
    },

    whereis(name: string): BeamPid | null {
      return registry.get(name) ?? null;
    },

    link(_pid: BeamPid): boolean {
      return true;
    },

    unlink(_pid: BeamPid): boolean {
      return true;
    },

    makeRef(): BeamRef {
      return makeRef();
    },

    nodes(): string[] {
      return [];
    },
  };
}

// ── Test helpers ───────────────────────────────────────────────────

/**
 * Activate the mock Beam API. Call in `beforeEach` to reset all state.
 */
export function setupMockBeam(): void {
  pidCounter = 1;
  refCounter = 1;
  processes.clear();
  registry.clear();
  monitors.clear();
  currentPid = makePid();
  processes.set(currentPid, { handler: null, inbox: [] });
  setMockBeam(buildMockBeam());
  beamFn = null;

  // Mock marker for gen-server.ts detection
  (globalThis as any).__quickbeam_mock = true;
  // Provide QuickbeamJs stub for spawned script evaluation
  (globalThis as any).QuickbeamJs = (globalThis as any).QuickbeamJs ?? {};

  (globalThis as any).__quickbeam_js_task_listener_setup = false;
  (globalThis as any).__quickbeam_js_reply_handlers = undefined;
}

/**
 * Get the current mock PID (the "test process").
 */
export function getMockPid(): BeamPid {
  return currentPid;
}

/**
 * Simulate delivery of a message to a specific PID.
 */
export function deliverMockMessage(pid: BeamPid, msg: any): void {
  deliverMessage(pid, msg);
}

/**
 * Simulate a process crash. Fires monitors and cleans up registrations.
 */
export function crashMockProcess(pid: BeamPid, reason?: any): void {
  handleProcessExit(pid, reason ?? "crash");
}

/**
 * Get a snapshot of all registered names.
 */
export function getMockRegistry(): Map<string, BeamPid> {
  return new Map(registry);
}

/**
 * Convenience: spawn a process with a function instead of a script.
 * Internally wraps the function in a script that evaluates it.
 * NOT part of the real Beam API — only for tests.
 */
export async function spawnMockFn(fn: () => Promise<void> | void): Promise<BeamPid> {
  const pid = makePid();
  processes.set(pid, { handler: null, inbox: [] });
  const prevPid = currentPid;
  currentPid = pid;
  try {
    await fn();
  } catch (err) {
    handleProcessExit(pid, err);
  } finally {
    currentPid = prevPid;
  }
  return pid;
}

/**
 * Check if two PIDs are equal (for tests).
 */
export function pidsEqual(a: BeamPid, b: BeamPid): boolean {
  return pidEquals(a, b);
}
