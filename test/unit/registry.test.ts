/**
 * Unit tests for Registry
 */

import { describe, it, expect, beforeEach } from "vitest";
import { setupMockBeam, getMockPid } from "../mock-beam.js";
import { Registry } from "../../src/registry.js";

describe("Registry", () => {
  beforeEach(() => {
    setupMockBeam();
  });

  describe("start", () => {
    it("should create a registry", async () => {
      const reg = await Registry.start("test_reg");
      expect(reg.name).toBe("test_reg");
    });

    it("should throw if name already taken", async () => {
      await Registry.start("dup");
      await expect(Registry.start("dup")).rejects.toThrow();
    });
  });

  describe("register / lookup (unique mode)", () => {
    it("should register and look up entries", async () => {
      const reg = await Registry.start("sessions");

      reg.register("alice", { role: "admin" });
      const result = reg.lookup("alice");
      expect(result).toBeDefined();
      expect(result![0][0]).toBeDefined(); // pid
      expect(result![0][1]).toEqual({ role: "admin" });
    });

    it("should throw on duplicate key in unique mode", async () => {
      const reg = await Registry.start("uniq");

      reg.register("key1", "value1");
      expect(() => reg.register("key1", "value2")).toThrow();
    });

    it("should allow different keys", async () => {
      const reg = await Registry.start("multi_keys");

      reg.register("a", 1);
      reg.register("b", 2);

      expect(reg.lookup("a")![0][1]).toBe(1);
      expect(reg.lookup("b")![0][1]).toBe(2);
    });

    it("should return undefined for unknown key", async () => {
      const reg = await Registry.start("empty");
      expect(reg.lookup("nope")).toBeUndefined();
    });
  });

  describe("register / lookup (duplicate mode)", () => {
    it("should allow multiple entries per key", async () => {
      const reg = await Registry.start("rooms", { keys: "duplicate" });

      reg.register("lobby", { user: "alice" });
      reg.register("lobby", { user: "bob" });

      const result = reg.lookup("lobby");
      expect(result).toHaveLength(2);
      expect(result![0][1]).toEqual({ user: "alice" });
      expect(result![1][1]).toEqual({ user: "bob" });
    });
  });

  describe("unregister", () => {
    it("should remove a registered entry", async () => {
      const reg = await Registry.start("temp");

      reg.register("key1", "val1");
      expect(reg.count()).toBe(1);

      reg.unregister("key1");
      expect(reg.count()).toBe(0);
      expect(reg.lookup("key1")).toBeUndefined();
    });

    it("should handle unregister of unknown key gracefully", async () => {
      const reg = await Registry.start("temp2");
      reg.unregister("nope"); // should not throw
    });
  });

  describe("match", () => {
    it("should match entries by predicate", async () => {
      const reg = await Registry.start("match_test");

      reg.register("room:lobby", { type: "chat" });
      reg.register("room:admin", { type: "chat" });
      reg.register("system:monitor", { type: "system" });

      const chatRooms = reg.match((key, _value) => key.startsWith("room:"));
      expect(chatRooms.size).toBe(2);

      const sysRooms = reg.match((_key, value) => value.type === "system");
      expect(sysRooms.size).toBe(1);
    });
  });

  describe("count", () => {
    it("should count registered entries", async () => {
      const reg = await Registry.start("counter");

      expect(reg.count()).toBe(0);
      reg.register("a", 1);
      reg.register("b", 2);
      expect(reg.count()).toBe(2);

      reg.unregister("a");
      expect(reg.count()).toBe(1);
    });
  });

  describe("lookup (static)", () => {
    it("should return a proxy to an existing registry", async () => {
      await Registry.start("shared");
      const proxy = Registry.lookup("shared");

      expect(proxy.name).toBe("shared");
      proxy.register("from_proxy", "hello");
      expect(proxy.lookup("from_proxy")![0][1]).toBe("hello");
    });

    it("should throw if registry not found", async () => {
      expect(() => Registry.lookup("nonexistent")).toThrow();
    });
  });
});
