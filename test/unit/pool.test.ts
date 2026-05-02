/**
 * Unit tests for Pool
 */

import { describe, it, expect, beforeEach } from "vitest";
import { setupMockBeam } from "../mock-beam.js";
import { GenServer } from "../../src/gen-server.js";
import { Pool } from "../../src/pool.js";
import { BeamOtpError } from "../../src/errors.js";

// ── Test worker ────────────────────────────────────────────────────

class TestWorker extends GenServer {
  async init(args?: any) {
    return { id: args?.id ?? "unknown", processed: 0 };
  }

  async handleCall(msg: any, _from: any, state: any) {
    if (msg === "ping") return { reply: "pong", state };
    if (msg === "echo") return { reply: `echo: ${state.id}`, state };
    if (msg === "crash") throw new Error("worker crash");
    return { reply: null, state };
  }

  async handleCast(msg: any, state: any) {
    if (msg === "inc") return { state: { ...state, processed: state.processed + 1 } };
    return { state };
  }
}

// ── Tests ──────────────────────────────────────────────────────────

describe("Pool", () => {
  beforeEach(() => {
    setupMockBeam();
  });

  describe("start", () => {
    it("should create a pool with the specified size", async () => {
      const pool = await Pool.start({
        name: "workers",
        size: 4,
        child: TestWorker,
      });

      const status = pool.status();
      expect(status.size).toBe(4);
      expect(status.idle).toBe(4);
      expect(status.active).toBe(0);
    });
  });

  describe("checkout / checkin", () => {
    it("should checkout and checkin a worker", async () => {
      const pool = await Pool.start({
        name: "workers",
        size: 2,
        child: TestWorker,
      });

      const worker = await pool.checkout();
      expect(pool.status().active).toBe(1);
      expect(pool.status().idle).toBe(1);

      pool.checkin(worker);
      expect(pool.status().active).toBe(0);
      expect(pool.status().idle).toBe(2);
    });

    it("should checkout all workers and block", async () => {
      const pool = await Pool.start({
        name: "limited",
        size: 1,
        child: TestWorker,
      });

      const w1 = await pool.checkout();
      expect(pool.status().idle).toBe(0);

      // Second checkout should timeout
      await expect(pool.checkout(50)).rejects.toThrow(BeamOtpError);

      pool.checkin(w1);
      // Now checkout should work
      const w2 = await pool.checkout(100);
      expect(w2).toBeDefined();
    });

    it("should use FIFO strategy by default", async () => {
      const pool = await Pool.start({
        name: "fifo_pool",
        size: 2,
        child: TestWorker,
        strategy: "fifo",
      });

      const w1 = await pool.checkout();
      const w2 = await pool.checkout();

      pool.checkin(w1);
      pool.checkin(w2);

      // First checked out should be first back
      const w3 = await pool.checkout();
      expect(w3).toBe(w1); // FIFO — w1 returned first

      pool.checkin(w3);
    });

    it.skip("should use LIFO strategy when specified", async () => {
      const pool = await Pool.start({
        name: "lifo_pool",
        size: 2,
        child: TestWorker,
        strategy: "lifo",
      });

      const w1 = await pool.checkout();
      const w2 = await pool.checkout();

      pool.checkin(w1);
      pool.checkin(w2);

      // LIFO: last checked in (w2) should be first out
      const w3 = await pool.checkout();
      // w3 should be the same worker as w2 (not w1)
      // In the mock, PID objects have an id property we can compare
      expect((w3 as any).id).toBe((w2 as any).id);

      pool.checkin(w3);
    });
  });

  describe("transaction", () => {
    it("should execute a transaction and return the worker", async () => {
      const pool = await Pool.start({
        name: "tx_pool",
        size: 2,
        child: TestWorker,
      });

      const result = await pool.transaction(async (worker) => {
        const reply = await GenServer.call(worker, "echo");
        return reply;
      });

      expect(result).toBe("echo: unknown");
      expect(pool.status().idle).toBe(2); // worker returned
    });

    it("should return worker even if transaction throws", async () => {
      const pool = await Pool.start({
        name: "tx_safe",
        size: 1,
        child: TestWorker,
      });

      await expect(
        pool.transaction(async () => {
          throw new Error("tx error");
        }),
      ).rejects.toThrow("tx error");

      // Worker should still be idle
      expect(pool.status().idle).toBe(1);
    });
  });

  describe("status", () => {
    it("should report correct status", async () => {
      const pool = await Pool.start({
        name: "status_pool",
        size: 3,
        child: TestWorker,
      });

      const w1 = await pool.checkout();
      const w2 = await pool.checkout();

      const s = pool.status();
      expect(s.size).toBe(3);
      expect(s.active).toBe(2);
      expect(s.idle).toBe(1);

      pool.checkin(w1);
      pool.checkin(w2);
      expect(pool.status().idle).toBe(3);
    });
  });
});
