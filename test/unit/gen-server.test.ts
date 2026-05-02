/**
 * Unit tests for GenServer
 */

import { describe, it, expect, beforeEach } from "vitest";
import { setupMockBeam, getMockPid } from "../mock-beam.js";
import { Beam } from "../../src/beam-shim.js";
import { GenServer } from "../../src/gen-server.js";
import { BeamOtpError } from "../../src/errors.js";

// ── Test GenServer subclasses ──────────────────────────────────────

class Counter extends GenServer {
  async init() {
    return { count: 0 };
  }

  async handleCall(msg: any, _from: any, state: any) {
    if (msg === "inc") return { reply: ++state.count, state };
    if (msg === "get") return { reply: state.count, state };
    if (msg === "crash") throw new Error("intentional crash");
    throw new Error(`unknown call: ${msg}`);
  }

  async handleCast(msg: any, state: any) {
    if (msg === "reset") return { state: { count: 0 } };
    if (msg === "inc") return { state: { count: state.count + 1 } };
    return { state };
  }

  async handleInfo(msg: any, state: any) {
    if (msg.type === "increment") return { state: { count: state.count + 1 } };
    return { state };
  }

  async terminate(_reason: any, _state: any) {
    // cleanup
  }
}

class EchoServer extends GenServer {
  async init(args: any) {
    return { echoCount: 0 };
  }

  async handleCall(msg: any, _from: any, state: any) {
    return { reply: msg, state: { echoCount: state.echoCount + 1 } };
  }
}

// ── Tests ──────────────────────────────────────────────────────────

describe("GenServer", () => {
  beforeEach(() => {
    setupMockBeam();
  });

  describe("startLink", () => {
    it("should start and return a PID", async () => {
      const pid = await GenServer.startLink(Counter);
      expect(pid).toBeDefined();
      expect(typeof pid).toBe("string");
      expect(pid).toMatch(/^<0\.\d+\.0>$/);
    });

    it("should register under a name if provided", async () => {
      const pid = await GenServer.startLink(Counter, { name: "test_counter" });
      const resolved = Beam.whereis("test_counter");
      expect(resolved).toBe(pid);
    });

    it("should throw already_started if name is taken", async () => {
      await GenServer.startLink(Counter, { name: "dup" });
      await expect(
        GenServer.startLink(Counter, { name: "dup" }),
      ).rejects.toThrow(BeamOtpError);
    });

    it("should pass args to init", async () => {
      class ArgsServer extends GenServer {
        async init(args: any) {
          return { received: args };
        }

        async handleCall(msg: any, _from: any, state: any) {
          if (msg === "get") return { reply: state.received, state };
          return { reply: null, state };
        }
      }

      await GenServer.startLink(ArgsServer, {
        name: "args_test",
        args: { hello: "world" },
      });

      const result = await GenServer.call("args_test", "get");
      expect(result).toEqual({ hello: "world" });
    });
  });

  describe("call", () => {
    it("should send a call and receive a reply", async () => {
      await GenServer.startLink(Counter, { name: "counter" });

      const count = await GenServer.call("counter", "get");
      expect(count).toBe(0);
    });

    it("should mutate state via call", async () => {
      await GenServer.startLink(Counter, { name: "counter" });

      await GenServer.call("counter", "inc");
      await GenServer.call("counter", "inc");
      const count = await GenServer.call("counter", "get");
      expect(count).toBe(2);
    });

    it("should throw noproc for unregistered name", async () => {
      await expect(
        GenServer.call("nonexistent", "msg"),
      ).rejects.toThrow(BeamOtpError);
    });

    it("should timeout if no reply", async () => {
      // Create a server that never replies
      class SlowServer extends GenServer {
        async handleCall(_msg: any, _from: any, state: any) {
          // Never returns reply (in real BEAM this would be a problem)
          await new Promise(() => {}); // never resolves
          return { reply: null, state };
        }
      }

      await GenServer.startLink(SlowServer, { name: "slow" });

      await expect(
        GenServer.call("slow", "msg", 100),
      ).rejects.toThrow(/timed out/);
    }, 500);

    it("should throw on handler crash", async () => {
      await GenServer.startLink(Counter, { name: "crash_test" });

      await expect(
        GenServer.call("crash_test", "crash"),
      ).rejects.toThrow();
    });
  });

  describe("cast", () => {
    it("should send a cast without waiting for reply", async () => {
      await GenServer.startLink(Counter, { name: "counter" });

      GenServer.cast("counter", "inc");
      // Give time for async delivery
      await new Promise((r) => setTimeout(r, 10));

      const count = await GenServer.call("counter", "get");
      expect(count).toBe(1);
    });

    it("should handle reset via cast", async () => {
      await GenServer.startLink(Counter, { name: "counter" });

      await GenServer.call("counter", "inc");
      await GenServer.call("counter", "inc");
      GenServer.cast("counter", "reset");
      await new Promise((r) => setTimeout(r, 10));

      const count = await GenServer.call("counter", "get");
      expect(count).toBe(0);
    });
  });

  describe("handleInfo", () => {
    it("should process arbitrary messages", async () => {
      await GenServer.startLink(Counter, { name: "counter" });

      // Send an info message (bypassing call/cast)
      const pid = Beam.whereis("counter")!;
      Beam.send(pid, { type: "increment" });
      await new Promise((r) => setTimeout(r, 10));

      const count = await GenServer.call("counter", "get");
      expect(count).toBe(1);
    });
  });

  describe("error handling", () => {
    it("should propagate handleCall errors to the caller", async () => {
      await GenServer.startLink(Counter, { name: "bad" });

      // The crash in handleCall causes the process to exit,
      // which the call should detect
      await expect(
        GenServer.call("bad", "crash"),
      ).rejects.toThrow();
    });

    it("should recover from cast errors (log and continue)", async () => {
      class CastErrorServer extends GenServer {
        async handleCast(msg: any, state: any) {
          if (msg === "boom") throw new Error("cast error");
          return { state: { ...state, ok: true } };
        }
      }

      await GenServer.startLink(CastErrorServer, { name: "cast_err" });
      GenServer.cast("cast_err", "boom");
      await new Promise((r) => setTimeout(r, 10));
      // Should not crash — cast errors are logged
    });
  });
});
