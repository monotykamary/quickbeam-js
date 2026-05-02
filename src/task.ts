/**
 * Task — fire-and-forget and awaitable one-shot computations.
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
  pid: BeamPid | null;
  earlyResult?: { ok: true; value: any } | { ok: false; error: string; stack?: string };
}

const pendingTasks = new Map<string, PendingTask>();

function taskKey(ref: BeamRef): string {
  return "task:" + ((ref as any).id ?? String(ref));
}

function ensureTaskListener(): void {
  if ((globalThis as any).__quickbeam_js_task_listener_setup) return;
  (globalThis as any).__quickbeam_js_task_listener_setup = true;

  Beam.onMessage((msg: any) => {
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "task_result" && msg.ref) {
      const entry = pendingTasks.get(taskKey(msg.ref));
      if (entry) {
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.resolve) {
          pendingTasks.delete(taskKey(msg.ref));
          entry.resolve(msg.result);
        } else {
          entry.earlyResult = { ok: true, value: msg.result };
        }
      }
    } else if (msg.type === "task_error" && msg.ref) {
      const entry = pendingTasks.get(taskKey(msg.ref));
      if (entry) {
        if (entry.timer) clearTimeout(entry.timer);
        if (entry.reject) {
          pendingTasks.delete(taskKey(msg.ref));
          entry.reject(
            new BeamOtpError("BeamOtpError:exit", `Task failed: ${msg.error}`, { reason: msg.stack }),
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
  async_<T>(fn: () => Promise<T>): TaskRef<T> {
    ensureTaskListener();

    const ref = Beam.makeRef();
    const parentPid = Beam.self();

    const stored: PendingTask = {
      resolve: null,
      reject: null,
      timer: null,
      pid: null,
    };
    pendingTasks.set(taskKey(ref), stored);

    // Spawn the task process
    const spawnPid = (Beam.spawn as any)(async () => {
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
    }) as BeamPid;

    stored.pid = spawnPid;

    return {
      pid: spawnPid,
      ref,
      cancel(): void {
        const e = pendingTasks.get(taskKey(ref));
        if (e) {
          if (e.timer) clearTimeout(e.timer);
          // Send shutdown to kill the task process
          if (e.pid) {
            Beam.send(e.pid, { type: "system", action: "shutdown", payload: "kill" });
          }
          pendingTasks.delete(taskKey(ref));
        }
      },
    };
  },

  await_<T>(ref: TaskRef<T>, timeout?: number): Promise<T> {
    const ms = timeout ?? 5000;

    return new Promise<T>((resolve, reject) => {
      const entry = pendingTasks.get(taskKey(ref.ref));
      if (!entry) {
        reject(BeamOtpError.notFound("task", String(ref.ref)));
        return;
      }

      if (entry.earlyResult) {
        const er = entry.earlyResult;
        pendingTasks.delete(taskKey(ref.ref));
        if (er.ok) {
          resolve(er.value);
        } else {
          reject(new BeamOtpError("BeamOtpError:exit", `Task failed: ${er.error}`, { reason: er.stack }));
        }
        return;
      }

      entry.timer = setTimeout(() => {
        pendingTasks.delete(taskKey(ref.ref));
        reject(BeamOtpError.timeout(`Task.await for ref '${ref.ref}'`, ms));
        if (entry.pid) {
          Beam.send(entry.pid, { type: "system", action: "shutdown", payload: "kill" });
        }
      }, ms);

      entry.resolve = (result: any) => {
        if (entry.timer) clearTimeout(entry.timer);
        pendingTasks.delete(taskKey(ref.ref));
        resolve(result);
      };
      entry.reject = (err: Error) => {
        if (entry.timer) clearTimeout(entry.timer);
        pendingTasks.delete(taskKey(ref.ref));
        reject(err);
      };
    });
  },

  async start(fn: () => Promise<void>): Promise<BeamPid> {
    return (Beam.spawn as any)(fn) as Promise<BeamPid>;
  },
};
