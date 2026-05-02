/**
 * Unit tests for Task
 */

import { describe, it, expect, beforeEach } from "vitest";
import { setupMockBeam } from "../mock-beam.js";
import { Task } from "../../src/task.js";
import { BeamOtpError } from "../../src/errors.js";

describe("Task", () => {
  beforeEach(() => {
    setupMockBeam();
  });

  describe("async / await", () => {
    it("should run a task and return its result", async () => {
      const ref = Task.async_(async () => {
        return 42;
      });

      const result = await Task.await_(ref);
      expect(result).toBe(42);
    });

    it("should handle complex return values", async () => {
      const ref = Task.async_(async () => {
        return { data: [1, 2, 3], meta: { count: 3 } };
      });

      const result = await Task.await_(ref);
      expect(result).toEqual({ data: [1, 2, 3], meta: { count: 3 } });
    });

    it("should timeout if task takes too long", async () => {
      const ref = Task.async_(async () => {
        await new Promise((r) => setTimeout(r, 500));
        return "too late";
      });

      await expect(
        Task.await_(ref, 50),
      ).rejects.toThrow(/timed out/);
    });

    it("should propagate task errors", async () => {
      const ref = Task.async_(async () => {
        throw new Error("task failure");
      });

      await expect(
        Task.await_(ref),
      ).rejects.toThrow(/Task failed.*task failure/);
    });
  });

  describe("start", () => {
    it("should spawn a fire-and-forget task", async () => {
      const pid = await Task.start(async () => {
        // fire and forget
      });

      expect(pid).toBeDefined();
      expect(typeof pid).toBe("string");
    });
  });

  describe("cancel", () => {
    it("should cancel a task", async () => {
      const ref = Task.async_(async () => {
        await new Promise((r) => setTimeout(r, 5000));
        return "never";
      });

      ref.cancel();

      // Now await should reject
      await expect(Task.await_(ref, 100)).rejects.toThrow();
    });
  });
});
