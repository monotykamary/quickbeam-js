/**
 * Mock Beam API for unit testing quickbeam-js modules.
 *
 * Simulates a QuickBEAM runtime in pure JS. All processes run in the
 * same thread, messages are dispatched via an event bus. Process context
 * is properly switched when delivering messages to different PIDs.
 *
 * @module test/mock-beam
 */

import { setMockBeam } from "../src/beam-shim.js";
import type {
  BeamAPI,
  BeamPid,
  BeamRef,
  BeamMonitorRef,
  BeamMessageHandler,
  BeamMonitorCallback,
} from "../src/beam-shim.js";

// ── Internal state ─────────────────────────────────────────────────

let pidCounter = 1;
let refCounter = 1;
let monitorRefCounter = 1;

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

/** Map<monitorRef, { targetPid, callback }> */
const monitors = new Map<
  BeamMonitorRef,
  {
    targetPid: BeamPid;
    callback: BeamMonitorCallback;
  }
>();

/** Current "self" — set per-test, changes during message delivery. */
let currentPid: BeamPid = makePid();

// ── Helpers ────────────────────────────────────────────────────────

function makePid(): BeamPid {
  return `<0.${pidCounter++}.0>`;
}

function makeRef(): BeamRef {
  return `#Ref<0.${refCounter++}>`;
}

function makeMonitorRef(): BeamMonitorRef {
  return `#Monitor<0.${monitorRefCounter++}>`;
}

function deliverMessage(pid: BeamPid, msg: any): void {
  const proc = processes.get(pid);
  if (!proc) return; // process doesn't exist — drop (BEAM behaviour)

  // Check global reply handlers first (used by GenServer.call)
  if (msg && msg.type === "reply" && msg.ref) {
    const replyHandlers = (globalThis as any).__quickbeam_js_reply_handlers as Map<string, (reply: any) => void> | undefined;
    if (replyHandlers?.has(msg.ref)) {
      const handler = replyHandlers.get(msg.ref)!;
      handler(msg);
      return;
    }
  }

  if (proc.handler) {
    // Switch process context before running handler
    const prevPid = currentPid;
    currentPid = pid;
    try {
      proc.handler(msg);
    } catch (err) {
      // Handler threw — treat as process exit
      handleProcessExit(pid, err);
    } finally {
      currentPid = prevPid;
    }
  } else {
    proc.inbox.push(msg);
  }
}

function handleProcessExit(pid: BeamPid, reason: any): void {
  // Clean up registrations FIRST so monitor callbacks (restarts) see clean state
  const namesToDelete: string[] = [];
  for (const [name, registeredPid] of registry) {
    if (registeredPid === pid) namesToDelete.push(name);
  }
  for (const name of namesToDelete) {
    registry.delete(name);
  }
  // Reset process handler
  const proc = processes.get(pid);
  if (proc) {
    proc.handler = null;
  }

  // Fire monitors (after cleanup — this enables safe restarts)
  const toFire: Array<{ pid: BeamPid; reason: any; callback: BeamMonitorCallback }> = [];
  for (const [monRef, mon] of monitors) {
    if (mon.targetPid === pid) {
      toFire.push({ pid, reason, callback: mon.callback });
      monitors.delete(monRef);
    }
  }
  // Fire monitor callbacks
  const prevPid = currentPid;
  for (const { pid: deadPid, reason: exitReason, callback } of toFire) {
    try {
      callback(deadPid, exitReason);
    } catch (_) {
      // Monitor callback errors are swallowed
    }
  }
  currentPid = prevPid;
}

// ── Mock Beam API ──────────────────────────────────────────────────

const mockBeam: BeamAPI = {
  async spawn(fn: () => Promise<void> | void): Promise<BeamPid> {
    const pid = makePid();
    processes.set(pid, { handler: null, inbox: [] });

    // Run fn in the new process's context
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
  },

  self(): BeamPid {
    return currentPid;
  },

  send(pid: BeamPid, message: any): void {
    deliverMessage(pid, message);
  },

  onMessage(handler: BeamMessageHandler): void {
    const pid = currentPid;
    const proc = processes.get(pid);
    if (!proc) {
      processes.set(pid, { handler, inbox: [] });
    } else {
      proc.handler = handler;
      // Drain any queued messages
      while (proc.inbox.length > 0) {
        const msg = proc.inbox.shift()!;
        handler(msg);
      }
    }
  },

  register(name: string, pid: BeamPid): void {
    registry.set(name, pid);
  },

  whereis(name: string): BeamPid | undefined {
    return registry.get(name);
  },

  unregister(name: string): void {
    registry.delete(name);
  },

  monitor(pid: BeamPid, cb: BeamMonitorCallback): BeamMonitorRef {
    const ref = makeMonitorRef();
    monitors.set(ref, { targetPid: pid, callback: cb });
    return ref;
  },

  demonitor(ref: BeamMonitorRef): void {
    monitors.delete(ref);
  },

  link(_pid: BeamPid): void {
    // no-op in mock
  },

  unlink(_pid: BeamPid): void {
    // no-op
  },

  makeRef(): BeamRef {
    return makeRef();
  },

  exit(reason: any): void {
    handleProcessExit(currentPid, reason);
  },

  exitProcess(pid: BeamPid, reason: any): void {
    handleProcessExit(pid, reason);
  },

  nodes(): string[] {
    return [];
  },

  callSync(target: string | BeamPid, message: any, _timeout?: number): any {
    const pid = typeof target === "string" ? registry.get(target) : target;
    if (pid) deliverMessage(pid, message);
    return undefined;
  },

  async call(target: string | BeamPid, message: any, _timeout?: number): Promise<any> {
    const pid = typeof target === "string" ? registry.get(target) : target;
    if (pid) deliverMessage(pid, message);
    return undefined;
  },

  async sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },

  async eval(target: BeamPid, code: string | ((scope: any) => void | Promise<void>), scope?: any): Promise<void> {
    const prevPid = currentPid;
    currentPid = target;
    try {
      if (typeof code === "function") {
        await (code as (scope: any) => void | Promise<void>)(scope);
      } else {
        // String code — evaluate in a function with scope as parameter
        const fn = new Function("scope", code);
        fn(scope);
      }
    } finally {
      currentPid = prevPid;
    }
  },
};

// ── Test helpers ───────────────────────────────────────────────────

/**
 * Activate the mock Beam API. Call in `beforeEach` to reset all state.
 */
export function setupMockBeam(): void {
  pidCounter = 1;
  refCounter = 1;
  monitorRefCounter = 1;
  processes.clear();
  registry.clear();
  monitors.clear();
  currentPid = `<0.${pidCounter++}.0>`;
  processes.set(currentPid, { handler: null, inbox: [] });
  setMockBeam(mockBeam);

  // Reset module-level state in task.ts
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
 * Get a snapshot of all registered names (for debugging).
 */
export function getMockRegistry(): Map<string, BeamPid> {
  return new Map(registry);
}
