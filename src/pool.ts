/**
 * Pool — fixed-size worker pool with checkout/checkin.
 *
 * A Pool is backed by a Supervisor managing `size` identical GenServer
 * workers. Uses Beam.spawn under the hood, compatible with both mock
 * and real QuickBEAM environments.
 *
 * @module pool
 */

import { Beam, BeamPid, BeamRef } from "./beam-shim.js";
import { BeamOtpError } from "./errors.js";
import type { PoolConfig, PoolStatus } from "./types.js";
import { Supervisor as SupervisorAPI } from "./supervisor.js";

// ── Exported Pool interface ────────────────────────────────────────

export interface Pool {
  pid: BeamPid;
  checkout(timeout?: number): Promise<BeamPid>;
  checkin(pid: BeamPid): void;
  status(): PoolStatus;
  transaction<T>(fn: (worker: BeamPid) => Promise<T>, timeout?: number): Promise<T>;
  shutdown(): Promise<void>;
}

// ── Internal state ─────────────────────────────────────────────────

interface PoolWorker {
  pid: BeamPid;
  inUse: boolean;
  monitorRef: BeamRef;
}

// ── Namespaced Static API ──────────────────────────────────────────

export const Pool = {
  async start(config: PoolConfig): Promise<Pool> {
    const {
      name,
      size,
      child: ChildClass,
      childArgs,
      strategy = "fifo",
      overflow: _overflow = 0,
      max_overflow: _maxOverflow = 0,
    } = config;

    const workers = new Map<string, PoolWorker>();
    const idleQueue: string[] = [];
    let waitingCheckouts: Array<{
      resolve: (pid: BeamPid) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }> = [];
    let shuttingDown = false;

    const childSpecs = [];
    for (let i = 0; i < size; i++) {
      childSpecs.push({
        id: `worker_${i}`,
        start: async () => {
          return ChildClass.startLink(ChildClass, {
            name: `${name}_${i}`,
            args: childArgs,
          });
        },
        restart: "permanent" as const,
        shutdown: 5000,
        type: "worker" as const,
      });
    }

    const sup = await SupervisorAPI.start({
      strategy: "one_for_one",
      children: childSpecs,
      max_restarts: size * 2,
      max_seconds: 5,
    });

    let idx = 0;
    for (const childInfo of sup.whichChildren()) {
      const workerId = childInfo.id;
      const monRef = Beam.monitor(childInfo.pid, (_reason: any) => {
        handleWorkerExit(workerId, _reason);
      });
      workers.set(workerId, {
        pid: childInfo.pid,
        inUse: false,
        monitorRef: monRef,
      });
      idleQueue.push(workerId);
      idx++;
    }

    function handleWorkerExit(workerId: string, _reason: any): void {
      const worker = workers.get(workerId);
      if (!worker) return;
      const qIdx = idleQueue.indexOf(workerId);
      if (qIdx !== -1) idleQueue.splice(qIdx, 1);
      worker.inUse = false;
    }

    function processQueue(): void {
      while (waitingCheckouts.length > 0 && idleQueue.length > 0) {
        const waiter = waitingCheckouts.shift()!;
        const workerId = strategy === "lifo" ? idleQueue.pop()! : idleQueue.shift()!;
        const worker = workers.get(workerId)!;
        worker.inUse = true;
        clearTimeout(waiter.timer);
        waiter.resolve(worker.pid);
      }
    }

    const pool: Pool = {
      pid: sup.pid,

      checkout(timeout = 5000): Promise<BeamPid> {
        if (shuttingDown) return Promise.reject(BeamOtpError.shutdown());

        if (idleQueue.length > 0) {
          const workerId = strategy === "lifo" ? idleQueue.pop()! : idleQueue.shift()!;
          const worker = workers.get(workerId)!;
          worker.inUse = true;
          return Promise.resolve(worker.pid);
        }

        return new Promise<BeamPid>((resolve, reject) => {
          const timer = setTimeout(() => {
            const wIdx = waitingCheckouts.findIndex(
              (w) => w.resolve === resolve && w.reject === reject,
            );
            if (wIdx !== -1) waitingCheckouts.splice(wIdx, 1);
            reject(BeamOtpError.timeout("Pool.checkout", timeout));
          }, timeout);
          waitingCheckouts.push({ resolve, reject, timer });
        });
      },

      checkin(pid: BeamPid): void {
        for (const [workerId, worker] of workers) {
          if (pidsEqual(worker.pid, pid) && worker.inUse) {
            worker.inUse = false;
            idleQueue.push(workerId);
            processQueue();
            return;
          }
        }
        console.warn(`[Pool] checkin: worker not found or already idle`);
      },

      status(): PoolStatus {
        let active = 0, idle = 0;
        for (const worker of workers.values()) {
          if (worker.inUse) active++;
          else idle++;
        }
        return { size, active, idle, overflow: 0 };
      },

      async transaction<T>(
        fn: (worker: BeamPid) => Promise<T>,
        timeout?: number,
      ): Promise<T> {
        const worker = await pool.checkout(timeout);
        try {
          return await fn(worker);
        } finally {
          pool.checkin(worker);
        }
      },

      async shutdown(): Promise<void> {
        shuttingDown = true;
        for (const waiter of waitingCheckouts) {
          clearTimeout(waiter.timer);
          waiter.reject(BeamOtpError.shutdown());
        }
        waitingCheckouts = [];
        await sup.shutdown();
      },
    };

    return pool;
  },
};

function pidsEqual(a: BeamPid, b: BeamPid): boolean {
  if ((a as any).__beam_type__ !== "pid" || (b as any).__beam_type__ !== "pid") {
    return false;
  }
  // Compare by stable identity: __beam_data__ (real QuickBEAM) or id (mock)
  const aData = (a as any).__beam_data__;
  const bData = (b as any).__beam_data__;
  if (aData !== undefined && bData !== undefined) {
    if (aData.length !== bData.length) return false;
    for (let i = 0; i < aData.length; i++) {
      if (aData[i] !== bData[i]) return false;
    }
    return true;
  }
  // Fallback to id for mock PIDs
  return (a as any).id === (b as any).id;
}
