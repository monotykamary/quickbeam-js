/**
 * Supervisor — manages child process lifecycles with restart strategies.
 *
 * @module supervisor
 */

import { Beam, BeamPid } from "./beam-shim.js";
import { BeamOtpError } from "./errors.js";
import type {
  ChildSpec,
  ChildInfo,
  ChildState,
  SupervisorConfig,
} from "./types.js";
import { sleep } from "./utils.js";

// ── Exported Supervisor interface ───────────────────────────────────

export interface Supervisor {
  readonly pid: BeamPid;
  whichChildren(): ChildInfo[];
  count(): { specs: number; active: number; supervisors: number; workers: number };
  shutdown(): Promise<void>;
}

// ── Internal handle (with mutation methods) ────────────────────────

interface SupervisorInternal extends Supervisor {
  _addChild(spec: ChildSpec): Promise<BeamPid>;
  _terminateChild(id: string): Promise<void>;
  _restartChild(id: string): Promise<BeamPid>;
  _shuttingDown(): boolean;
}

// ── Namespaced Static API ──────────────────────────────────────────

export const Supervisor = {
  async start(config: SupervisorConfig): Promise<Supervisor> {
    return createSupervisor(config);
  },

  async startChild(sup: Supervisor, spec: ChildSpec): Promise<BeamPid> {
    const internal = sup as SupervisorInternal;
    if (internal._shuttingDown()) throw BeamOtpError.shutdown();
    return internal._addChild(spec);
  },

  async terminateChild(sup: Supervisor, id: string): Promise<void> {
    const internal = sup as SupervisorInternal;
    await internal._terminateChild(id);
  },

  async restartChild(sup: Supervisor, id: string): Promise<BeamPid> {
    const internal = sup as SupervisorInternal;
    return internal._restartChild(id);
  },
};

// ── Internal implementation ────────────────────────────────────────

async function createSupervisor(config: SupervisorConfig): Promise<SupervisorInternal> {
  const {
    strategy = "one_for_one",
    children: childSpecs,
    max_restarts = 3,
    max_seconds = 5,
  } = config;

  const children = new Map<string, ChildState>();
  const startOrder: string[] = [];
  let shuttingDown = false;
  let inRestart = false; // suppress handleChildExit during controlled restarts
  const restartTimestamps: number[] = [];
  const pid = Beam.self();

  function trackRestart(): void {
    const now = Date.now();
    const windowStart = now - max_seconds * 1000;
    while (restartTimestamps.length > 0 && restartTimestamps[0] < windowStart) {
      restartTimestamps.shift();
    }
    restartTimestamps.push(now);
    if (restartTimestamps.length > max_restarts) {
      const err = BeamOtpError.restartLimit(max_restarts, max_seconds);
      shutdownAll().then(() => Beam.exit("shutdown"));
      throw err;
    }
  }

  async function shutdownAll(): Promise<void> {
    shuttingDown = true;
    const reversed = [...startOrder].reverse();
    for (const id of reversed) {
      await terminateChildInternal(id);
    }
  }

  async function terminateChildInternal(id: string): Promise<void> {
    const child = children.get(id);
    if (!child || child.pid === null) return;

    const shutdownMs = child.spec.shutdown ?? 5000;
    const childPid = child.pid;

    // Use Promise-based monitoring for proper async exit handling
    let monRef: string | null = null;
    const exitPromise = new Promise<void>((resolve) => {
      monRef = Beam.monitor(childPid, () => {
        resolve();
      });
    });

    Beam.send(childPid, { type: "system", action: "shutdown", payload: "shutdown" });

    if (shutdownMs === "infinity") {
      await exitPromise;
    } else {
      const result = await Promise.race([
        exitPromise.then(() => "exit" as const),
        sleep(shutdownMs as number).then(() => "timeout" as const),
      ]);
      if (result === "timeout") {
        Beam.exitProcess(childPid, "kill");
        await exitPromise;
      }
    }

    if (monRef) Beam.demonitor(monRef);
    if (child.monitorRef) Beam.demonitor(child.monitorRef);
    child.pid = null;
    child.monitorRef = null;
  }

  function handleChildExit(id: string, reason: any): void {
    if (shuttingDown || inRestart) return;
    const child = children.get(id);
    if (!child) return;

    child.pid = null;
    child.monitorRef = null;

    const restart = child.spec.restart ?? "permanent";
    let shouldRestart = false;
    switch (restart) {
      case "permanent": shouldRestart = true; break;
      case "temporary": shouldRestart = false; break;
      case "transient": shouldRestart = reason !== "normal" && reason !== "shutdown"; break;
    }

    if (!shouldRestart) return;

    trackRestart();

    switch (strategy) {
      case "one_for_one":
        restartChildInternal(id).catch((err: Error) => {
          console.error(`[Supervisor] failed to restart child '${id}':`, err);
        });
        break;
      case "one_for_all":
        restartAllChildren().catch((err: Error) => {
          console.error("[Supervisor] failed to restart all children:", err);
        });
        break;
      case "rest_for_one":
        restartFromChild(id).catch((err: Error) => {
          console.error(`[Supervisor] failed to restart from child '${id}':`, err);
        });
        break;
    }
  }

  async function restartChildInternal(id: string): Promise<BeamPid> {
    const child = children.get(id);
    if (!child) throw BeamOtpError.notFound("child", id);

    if (child.pid !== null) {
      await terminateChildInternal(id);
    }

    child.restarts++;
    const newPid = await child.spec.start();
    child.pid = newPid;
    child.startTime = Date.now();

    const monRef = Beam.monitor(newPid, (_p, reason) => {
      handleChildExit(id, reason);
    });
    child.monitorRef = monRef;

    return newPid;
  }

  async function restartAllChildren(): Promise<void> {
    inRestart = true;
    try {
      const reversed = [...startOrder].reverse();
      for (const id of reversed) {
        const child = children.get(id);
        if (child && child.pid !== null) {
          await terminateChildInternal(id);
        }
      }
      for (const id of startOrder) {
        await restartChildInternal(id);
      }
    } finally {
      inRestart = false;
    }
  }

  async function restartFromChild(crashedId: string): Promise<void> {
    inRestart = true;
    try {
      const idx = startOrder.indexOf(crashedId);
      if (idx === -1) return;
      for (let i = startOrder.length - 1; i >= idx; i--) {
        const id = startOrder[i];
        const child = children.get(id);
        if (child && child.pid !== null) {
          await terminateChildInternal(id);
        }
      }
      for (let i = idx; i < startOrder.length; i++) {
        await restartChildInternal(startOrder[i]);
      }
    } finally {
      inRestart = false;
    }
  }

  async function startChildInternal(spec: ChildSpec): Promise<BeamPid> {
    const childPid = await spec.start();
    const childState: ChildState = {
      spec,
      pid: childPid,
      monitorRef: null,
      restarts: 0,
      startTime: Date.now(),
    };
    const monRef = Beam.monitor(childPid, (_p, reason) => {
      handleChildExit(spec.id, reason);
    });
    childState.monitorRef = monRef;
    children.set(spec.id, childState);
    return childPid;
  }

  // Build the supervisor handle
  const sup: SupervisorInternal = {
    pid,

    whichChildren(): ChildInfo[] {
      const result: ChildInfo[] = [];
      for (const [id, child] of children) {
        if (child.pid !== null) {
          result.push({
            id,
            pid: child.pid,
            type: child.spec.type ?? "worker",
            restart: child.spec.restart ?? "permanent",
          });
        }
      }
      return result;
    },

    count() {
      let specs = 0, active = 0, supervisors = 0, workers = 0;
      for (const [, child] of children) {
        specs++;
        if (child.pid !== null) {
          active++;
          if ((child.spec.type ?? "worker") === "supervisor") supervisors++;
          else workers++;
        }
      }
      return { specs, active, supervisors, workers };
    },

    async shutdown(): Promise<void> {
      await shutdownAll();
    },

    async _addChild(spec: ChildSpec): Promise<BeamPid> {
      if (shuttingDown) throw BeamOtpError.shutdown();
      if (children.has(spec.id)) {
        throw new BeamOtpError("already_started", `Child '${spec.id}' already exists`);
      }
      const childPid = await startChildInternal(spec);
      startOrder.push(spec.id);
      return childPid;
    },

    async _terminateChild(id: string): Promise<void> {
      if (!children.has(id)) throw BeamOtpError.notFound("child", id);
      // Demonitor the child BEFORE terminating so the exit doesn't trigger restart
      const child = children.get(id)!;
      if (child.monitorRef) {
        Beam.demonitor(child.monitorRef);
        child.monitorRef = null;
      }
      await terminateChildInternal(id);
      children.delete(id);
      const idx = startOrder.indexOf(id);
      if (idx !== -1) startOrder.splice(idx, 1);
    },

    async _restartChild(id: string): Promise<BeamPid> {
      if (!children.has(id)) throw BeamOtpError.notFound("child", id);
      if (!startOrder.includes(id)) startOrder.push(id);
      return restartChildInternal(id);
    },

    _shuttingDown(): boolean {
      return shuttingDown;
    },
  };

  // Start children in order
  const started: string[] = [];
  try {
    for (const spec of childSpecs) {
      await startChildInternal(spec);
      started.push(spec.id);
      startOrder.push(spec.id);
    }
  } catch (err) {
    for (const id of [...started].reverse()) {
      try { await terminateChildInternal(id); } catch (_) {}
    }
    for (const id of started) {
      children.delete(id);
      const idx2 = startOrder.indexOf(id);
      if (idx2 !== -1) startOrder.splice(idx2, 1);
    }
    throw err;
  }

  return sup;
}
