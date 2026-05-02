/**
 * Task — fire-and-forget and awaitable one-shot computations.
 *
 * `Task.async(fn)` spawns a new process, runs `fn`, and returns a ref.
 * `Task.await(ref)` blocks until the result arrives (or timeout).
 * `Task.start(fn)` is fire-and-forget — no result is collected.
 *
 * Uses BEAM message passing for result delivery from the spawned
 * process back to the caller.
 *
 * @module task
 */

import { Beam, BeamPid, BeamRef } from "./beam-shim.js";
import { BeamOtpError } from "./errors.js";
import type { TaskRef } from "./types.js";

// ── Internal state ─────────────────────────────────────────────────

interface PendingTask {
  resolve: ((result: any) => void) | null;
  reject: ((err: Error) => void) | null;
  timer: ReturnType<typeof setTimeout> | null;
  pid: BeamPid;
  /** Store early result if it arrives before await_() is called. */
  earlyResult?: { ok: true; value: any } | { ok: false; error: string; stack?: string };
}

const pendingTasks = new Map<BeamRef, PendingTask>();

function ensureTaskListener(): void {
  // Check global flag (resettable by mock setup)
  if ((globalThis as any).__beam_otp_task_listener_setup) return;
  (globalThis as any).__beam_otp_task_listener_setup = true;

  Beam.onMessage((msg: any) => {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "task_result" && msg.ref) {
      const entry = pendingTasks.get(msg.ref);
      if (entry) {
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.resolve) {
          // await_() already called — resolve immediately
          pendingTasks.delete(msg.ref);
          entry.resolve(msg.result);
        } else {
          // await_() not called yet — store for later
          entry.earlyResult = { ok: true, value: msg.result };
        }
      }
    } else if (msg.type === "task_error" && msg.ref) {
      const entry = pendingTasks.get(msg.ref);
      if (entry) {
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.reject) {
          pendingTasks.delete(msg.ref);
          entry.reject(
            new BeamOtpError("exit", `Task failed: ${msg.error}`, msg.stack),
          );
        } else {
          entry.earlyResult = { ok: false, error: msg.error, stack: msg.stack };
        }
      }
    }
  });
}

// ── Namespaced Static API ──────────────────────────────────────────

export const Task = {
  /**
   * Spawn a one-shot task and return a ref for awaiting its result.
   *
   * @param fn - The async function to run in a new process.
   * @returns A `TaskRef` with `pid`, `ref`, and `cancel()`.
   */
  async_<T>(fn: () => Promise<T>): TaskRef<T> {
    ensureTaskListener();

    const ref = Beam.makeRef();
    const parentPid = Beam.self();

    const stored: PendingTask = {
      resolve: null,
      reject: null,
      timer: null,
      pid: "" as BeamPid,
    };
    pendingTasks.set(ref, stored);

    // Spawn the task process
    Beam.spawn(async () => {
      try {
        const result = await fn();
        Beam.send(parentPid, { type: "task_result", ref, result });
      } catch (err) {
        Beam.send(parentPid, {
          type: "task_error",
          ref,
          error: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        });
      }
    }).then((spawnedPid) => {
      stored.pid = spawnedPid;
    });

    return {
      pid: stored.pid,
      ref,
      cancel(): void {
        const e = pendingTasks.get(ref);
        if (e) {
          if (e.timer) clearTimeout(e.timer);
          if (e.pid) Beam.exitProcess(e.pid, "kill");
          pendingTasks.delete(ref);
        }
      },
    };
  },

  /**
   * Await the result of a task started with `Task.async()`.
   *
   * @param ref - The `TaskRef` returned by `Task.async()`.
   * @param timeout - Milliseconds to wait (default: 5000).
   * @returns The task's return value.
   * @throws BeamOtpError on timeout or if the task threw.
   */
  await_<T>(ref: TaskRef<T>, timeout?: number): Promise<T> {
    const ms = timeout ?? 5000;

    return new Promise<T>((resolve, reject) => {
      const entry = pendingTasks.get(ref.ref);
      if (!entry) {
        reject(BeamOtpError.notFound("task", ref.ref));
        return;
      }

      // Check if result already arrived
      if (entry.earlyResult) {
        const er = entry.earlyResult;
        pendingTasks.delete(ref.ref);
        if (er.ok) {
          resolve(er.value);
        } else {
          reject(new BeamOtpError("exit", `Task failed: ${er.error}`, er.stack));
        }
        return;
      }

      entry.timer = setTimeout(() => {
        pendingTasks.delete(ref.ref);
        reject(BeamOtpError.timeout(`Task.await for ref '${ref.ref}'`, ms));
        if (entry.pid) Beam.exitProcess(entry.pid, "kill");
      }, ms);

      entry.resolve = (result: any) => {
        if (entry.timer) clearTimeout(entry.timer);
        pendingTasks.delete(ref.ref);
        resolve(result);
      };
      entry.reject = (err: Error) => {
        if (entry.timer) clearTimeout(entry.timer);
        pendingTasks.delete(ref.ref);
        reject(err);
      };
    });
  },

  /**
   * Fire-and-forget: spawn a one-shot process and don't wait.
   *
   * @param fn - The function to run.
   * @returns The PID of the spawned process.
   */
  async start(fn: () => Promise<void>): Promise<BeamPid> {
    return Beam.spawn(fn);
  },
};
