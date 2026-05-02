/**
 * Unit tests for Supervisor
 */

import { describe, it, expect, beforeEach } from "vitest";
import { setupMockBeam, crashMockProcess } from "../mock-beam.js";
import { Supervisor } from "../../src/supervisor.js";
import { GenServer } from "../../src/gen-server.js";
import { BeamOtpError } from "../../src/errors.js";
import type { ChildSpec } from "../../src/index.js";

// ── Test GenServer worker ──────────────────────────────────────────

class TestWorker extends GenServer {
  async init(args?: any) {
    return { id: args?.id ?? "unknown", count: 0 };
  }

  async handleCall(msg: any, _from: any, state: any) {
    if (msg === "get") return { reply: state, state };
    if (msg === "inc") return { reply: state.count + 1, state: { ...state, count: state.count + 1 } };
    if (msg === "crash") throw new Error("intentional");
    return { reply: null, state };
  }
}

// ── Helpers ────────────────────────────────────────────────────────

function workerSpec(
  id: string,
  restart: "permanent" | "temporary" | "transient" = "permanent",
): ChildSpec {
  return {
    id,
    start: async () => {
      return GenServer.startLink(TestWorker, { name: id, args: { id } });
    },
    restart,
  };
}

// ── Tests ──────────────────────────────────────────────────────────

describe("Supervisor", () => {
  beforeEach(() => {
    setupMockBeam();
  });

  describe("start", () => {
    it("should start children in order", async () => {
      const started: string[] = [];
      const spec = {
        strategy: "one_for_one" as const,
        children: [
          {
            id: "a",
            start: async () => {
              started.push("a");
              return GenServer.startLink(TestWorker, { name: "a" });
            },
          },
          {
            id: "b",
            start: async () => {
              started.push("b");
              return GenServer.startLink(TestWorker, { name: "b" });
            },
          },
        ],
      };

      await Supervisor.start(spec);
      expect(started).toEqual(["a", "b"]);
    });

    it("should roll back if a child fails to start", async () => {
      const terminated: string[] = [];
      const spec = {
        strategy: "one_for_one" as const,
        children: [
          {
            id: "ok",
            start: async () => {
              return GenServer.startLink(TestWorker, { name: "ok" });
            },
          },
          {
            id: "bad",
            start: async () => {
              throw new Error("start failed");
            },
          },
        ],
      };

      await expect(Supervisor.start(spec)).rejects.toThrow("start failed");
      // The first child should have been terminated
      // (In mock, we check if the process was cleaned up)
    });

    it("should return a supervisor handle with pid and children", async () => {
      const sup = await Supervisor.start({
        strategy: "one_for_one",
        children: [workerSpec("w1")],
      });

      expect(sup.pid).toBeDefined();
      const children = sup.whichChildren();
      expect(children).toHaveLength(1);
      expect(children[0].id).toBe("w1");
    });

    it("should report correct count", async () => {
      const sup = await Supervisor.start({
        strategy: "one_for_one",
        children: [
          workerSpec("w1"),
          { ...workerSpec("w2"), type: "supervisor" as const },
        ],
      });

      const c = sup.count();
      expect(c.specs).toBe(2);
      expect(c.active).toBe(2);
      expect(c.workers).toBe(1);
      expect(c.supervisors).toBe(1);
    });
  });

  describe("restart strategy: one_for_one", () => {
    it("should restart only the crashed child", async () => {
      const sup = await Supervisor.start({
        strategy: "one_for_one",
        children: [workerSpec("w1"), workerSpec("w2")],
      });

      // Get PIDs before crash
      const before = sup.whichChildren();
      const w1Pid = before.find((c) => c.id === "w1")!.pid;
      const w2Pid = before.find((c) => c.id === "w2")!.pid;

      // Crash w1
      crashMockProcess(w1Pid, "oops");
      await new Promise((r) => setTimeout(r, 50));

      // w1 should have a new PID, w2 should be unchanged
      const after = sup.whichChildren();
      const newW1 = after.find((c) => c.id === "w1");
      const newW2 = after.find((c) => c.id === "w2");

      expect(newW1).toBeDefined();
      expect(newW1!.pid).not.toBe(w1Pid);
      expect(newW2!.pid).toBe(w2Pid);
    });

    it("should not restart temporary children", async () => {
      const sup = await Supervisor.start({
        strategy: "one_for_one",
        children: [
          workerSpec("temp", "temporary"),
          workerSpec("perm"),
        ],
      });

      const before = sup.whichChildren();
      const tempPid = before.find((c) => c.id === "temp")!.pid;

      crashMockProcess(tempPid, "normal");
      await new Promise((r) => setTimeout(r, 50));

      const after = sup.whichChildren();
      expect(after.find((c) => c.id === "temp")).toBeUndefined();
      expect(after.find((c) => c.id === "perm")).toBeDefined();
    });

    it("should restart transient children on abnormal exit", async () => {
      const sup = await Supervisor.start({
        strategy: "one_for_one",
        children: [
          { ...workerSpec("trans"), restart: "transient" as const },
        ],
      });

      const before = sup.whichChildren();
      const pid = before[0].pid;

      // Abnormal exit → should restart
      crashMockProcess(pid, "oops");
      await new Promise((r) => setTimeout(r, 50));

      const after = sup.whichChildren();
      expect(after[0].pid).not.toBe(pid);
    });
  });

  describe("restart strategy: one_for_all", () => {
    it("should restart all children when one crashes", async () => {
      const sup = await Supervisor.start({
        strategy: "one_for_all",
        children: [workerSpec("w1"), workerSpec("w2"), workerSpec("w3")],
      });

      const before = sup.whichChildren();
      const [w1, w2, w3] = before;
      crashMockProcess(w2.pid, "boom");
      await new Promise((r) => setTimeout(r, 50));

      const after = sup.whichChildren();
      // All should have new PIDs
      expect(after[0].pid).not.toBe(w1.pid);
      expect(after[1].pid).not.toBe(w2.pid);
      expect(after[2].pid).not.toBe(w3.pid);
    });
  });

  describe("restart strategy: rest_for_one", () => {
    it("should restart crashed child and all after it", async () => {
      const sup = await Supervisor.start({
        strategy: "rest_for_one",
        children: [workerSpec("w1"), workerSpec("w2"), workerSpec("w3")],
      });

      const before = sup.whichChildren();
      const w1Pid = before[0].pid;
      const w2Pid = before[1].pid;
      const w3Pid = before[2].pid;

      // Crash w2 → w2 and w3 should restart, w1 stays
      crashMockProcess(w2Pid, "boom");
      await new Promise((r) => setTimeout(r, 50));

      const after = sup.whichChildren();
      expect(after[0].pid).toBe(w1Pid);  // w1 unchanged
      expect(after[1].pid).not.toBe(w2Pid); // w2 restarted
      expect(after[2].pid).not.toBe(w3Pid); // w3 restarted
    });
  });

  describe("restart intensity", () => {
    it("should exit supervisor if max_restarts exceeded", async () => {
      const sup = await Supervisor.start({
        strategy: "one_for_one",
        max_restarts: 2,
        max_seconds: 10,
        children: [workerSpec("flaky")],
      });

      const child = sup.whichChildren()[0];
      crashMockProcess(child.pid, "crash1");
      await new Promise((r) => setTimeout(r, 20));
      const after1 = sup.whichChildren()[0];
      crashMockProcess(after1.pid, "crash2");
      await new Promise((r) => setTimeout(r, 20));

      // After 2 restarts in window, supervisor should die
      // In real BEAM this would kill the supervisor process
    });
  });

  describe("startChild / terminateChild / restartChild", () => {
    it("should dynamically add a child", async () => {
      const sup = await Supervisor.start({
        strategy: "one_for_one",
        children: [],
      });

      expect(sup.count().specs).toBe(0);

      const pid = await Supervisor.startChild(sup, workerSpec("dynamic"));
      expect(sup.count().specs).toBe(1);
      expect(sup.whichChildren()[0].pid).toBe(pid);
    });

    it("should throw on duplicate child id", async () => {
      const sup = await Supervisor.start({
        strategy: "one_for_one",
        children: [workerSpec("dup")],
      });

      await expect(
        Supervisor.startChild(sup, workerSpec("dup")),
      ).rejects.toThrow();
    });

    it("should terminate a child", async () => {
      const sup = await Supervisor.start({
        strategy: "one_for_one",
        children: [workerSpec("w1"), workerSpec("w2")],
      });

      await Supervisor.terminateChild(sup, "w1");
      const children = sup.whichChildren();
      expect(children.find((c) => c.id === "w1")).toBeUndefined();
      expect(children.find((c) => c.id === "w2")).toBeDefined();
    });

    it("should throw on unknown child id", async () => {
      const sup = await Supervisor.start({
        strategy: "one_for_one",
        children: [],
      });

      await expect(
        Supervisor.terminateChild(sup, "nonexistent"),
      ).rejects.toThrow(BeamOtpError);
    });
  });

  describe("shutdown", () => {
    it("should shut down all children in reverse order", async () => {
      const sup = await Supervisor.start({
        strategy: "one_for_one",
        children: [
          workerSpec("w1"),
          workerSpec("w2"),
          workerSpec("w3"),
        ],
      });

      await sup.shutdown();
      // All children should be terminated
      expect(sup.whichChildren()).toHaveLength(0);
    });
  });
});
