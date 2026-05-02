/**
 * Unit tests for Application
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setupMockBeam } from "../mock-beam.js";
import { Application } from "../../src/application.js";
import { GenServer } from "../../src/gen-server.js";
import { BeamOtpError } from "../../src/errors.js";

class AppWorker extends GenServer {
  async init(_args?: any) {
    return { started: true };
  }
}

describe("Application", () => {
  beforeEach(() => {
    setupMockBeam();
  });

  afterEach(async () => {
    // Clean up any apps started during the test
    for (const { id } of Application.which()) {
      try { await Application.stop(id); } catch (_) {}
    }
  });

  describe("start", () => {
    it("should start an application with a root supervisor", async () => {
      const app = await Application.start({
        id: "test_app",
        supervisor: {
          strategy: "one_for_one",
          children: [
            {
              id: "worker1",
              start: () => GenServer.startLink(AppWorker, { name: "worker1" }),
            },
          ],
        },
      });

      expect(app.id).toBe("test_app");
      expect(app.supervisor).toBeDefined();
      expect(app.supervisor.count().specs).toBe(1);
    });

    it("should set and get environment values", async () => {
      const app = await Application.start({
        id: "env_app",
        env: { port: 4000, debug: true },
        supervisor: {
          strategy: "one_for_one",
          children: [],
        },
      });

      expect(app.getEnv("port")).toBe(4000);
      expect(app.getEnv("debug")).toBe(true);
      expect(app.getEnv("nonexistent")).toBeUndefined();

      app.putEnv("new_key", "new_val");
      expect(app.getEnv("new_key")).toBe("new_val");
    });

    it("should throw on duplicate app id", async () => {
      await Application.start({
        id: "dup_app",
        supervisor: { strategy: "one_for_one", children: [] },
      });

      await expect(
        Application.start({
          id: "dup_app",
          supervisor: { strategy: "one_for_one", children: [] },
        }),
      ).rejects.toThrow(BeamOtpError);
    });
  });

  describe("stop", () => {
    it("should stop an application by id", async () => {
      await Application.start({
        id: "stoppable",
        supervisor: { strategy: "one_for_one", children: [] },
      });

      await Application.stop("stoppable");

      const apps = Application.which();
      expect(apps.find((a) => a.id === "stoppable")).toBeUndefined();
    });

    it("should throw for unknown app id", async () => {
      await expect(Application.stop("nonexistent")).rejects.toThrow(BeamOtpError);
    });
  });

  describe("which", () => {
    it("should list all running applications", async () => {
      await Application.start({
        id: "app_a",
        supervisor: { strategy: "one_for_one", children: [] },
      });
      await Application.start({
        id: "app_b",
        supervisor: { strategy: "one_for_one", children: [] },
      });

      const apps = Application.which();
      expect(apps).toHaveLength(2);
      expect(apps.map((a) => a.id).sort()).toEqual(["app_a", "app_b"]);
    });
  });
});
