/**
 * Pool — fixed-size worker pool with checkout/checkin.
 *
 * A Pool is backed by a Supervisor managing `size` identical GenServer
 * workers. Idle workers are queued; `checkout` borrows one, `checkin`
 * returns it. If a worker crashes while checked out, the supervisor
 * restarts it.
 *
 * @module pool
 */

import { Beam, BeamPid, BeamMonitorRef } from "./beam-shim.js";
import { BeamOtpError } from "./errors.js";
import type { PoolConfig, PoolStatus } from "./types.js";
import { Supervisor as SupervisorAPI } from "./supervisor.js";

// ── Exported Pool interface ────────────────────────────────────────

export interface Pool {
  /** The pool supervisor's PID. */
  pid: BeamPid;

  /** Borrow a worker. Blocks up to `timeout` ms (default: 5000). */
  checkout(timeout?: number): Promise<BeamPid>;

  /** Return a worker to the pool. */
  checkin(pid: BeamPid): void;

  /** Get pool status snapshot. */
  status(): PoolStatus;

  /**
   * Execute a transaction: checkout, run fn, checkin.
   * Guarantees the worker is returned even if fn throws.
   */
  transaction<T>(fn: (worker: BeamPid) => Promise<T>, timeout?: number): Promise<T>;

  /** Shut down the pool and all workers. */
  shutdown(): Promise<void>;
}

// ── Internal state ─────────────────────────────────────────────────

interface PoolWorker {
  pid: BeamPid;
  inUse: boolean;
  monitorRef: BeamMonitorRef;
}

// ── Namespaced Static API ──────────────────────────────────────────

export const Pool = {
  /**
   * Start a new worker pool.
   */
  async start(config: PoolConfig): Promise<Pool> {
    const {
      name,
      size,
      child: ChildClass,
      childArgs,
      strategy = "fifo",
      overflow:_overflow = 0,
      max_overflow:_maxOverflow = 0,
    } = config;

    const workers = new Map<string, PoolWorker>();
    const idleQueue: string[] = [];
    let waitingCheckouts: Array<{
      resolve: (pid: BeamPid) => void;
      reject: (err: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }> = [];
    let shuttingDown = false;

    // Build child specs
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

    // Start the backing supervisor
    const sup = await SupervisorAPI.start({
      strategy: "one_for_one",
      children: childSpecs,
      max_restarts: size * 2,
      max_seconds: 5,
    });

    // Populate workers from supervisor
    let idx = 0;
    for (const childInfo of sup.whichChildren()) {
      const workerId = childInfo.id;
      const monRef = Beam.monitor(childInfo.pid, (_p, reason) => {
        handleWorkerExit(workerId, reason);
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
          if (worker.pid === pid && worker.inUse) {
            worker.inUse = false;
            idleQueue.push(workerId);
            processQueue();
            return;
          }
        }
        console.warn(`[Pool] checkin: worker ${pid} not found or already idle`);
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
