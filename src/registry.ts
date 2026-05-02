/**
 * Registry — named process registry backed by `Beam.register`/`Beam.whereis`.
 *
 * A Registry maps string keys to `{ pid, value }` entries. It supports
 * both `unique` (one process per key) and `duplicate` (many processes).
 * Registrations are automatically cleaned up when monitored processes exit.
 *
 * @module registry
 */

import { Beam, BeamPid, BeamMonitorRef } from "./beam-shim.js";
import { BeamOtpError } from "./errors.js";
import type { RegistryConfig, RegistryKeysMode } from "./types.js";

// ── Exported Registry interface ────────────────────────────────────

export interface Registry {
  /** The name this registry is registered under. */
  readonly name: string;

  /** Register a key → { pid, value } mapping for the calling process. */
  register(key: string, value: any): void;

  /** Unregister a key for the calling process. */
  unregister(key: string): void;

  /** Look up entries for a key. Returns `[pid, value][]` (always an array). */
  lookup(key: string): [BeamPid, any][] | undefined;

  /** Match entries by predicate. Returns `Map<key, [pid, value][]>`. */
  match(predicate: (key: string, value: any) => boolean): Map<string, [BeamPid, any][]>;

  /** Count total registered entries. */
  count(): number;
}

// ── Internal state ─────────────────────────────────────────────────

interface InternalEntry {
  pid: BeamPid;
  value: any;
  monitorRef: BeamMonitorRef;
}

// ── Active registries (name → internal state) ──────────────────────

const activeRegistries = new Map<string, {
  keysMode: RegistryKeysMode;
  entries: Map<string, InternalEntry | InternalEntry[]>;
}>();

// ── Namespaced Static API ──────────────────────────────────────────

export const Registry = {
  /**
   * Start a new Registry and register it by name.
   */
  async start(name: string, config?: RegistryConfig): Promise<Registry> {
    const keysMode: RegistryKeysMode = config?.keys ?? "unique";
    const entries = new Map<string, InternalEntry | InternalEntry[]>();

    if (activeRegistries.has(name)) {
      throw BeamOtpError.alreadyStarted(`Registry '${name}'`);
    }

    activeRegistries.set(name, { keysMode, entries });

    // Register the current process under the registry name
    Beam.register(name, Beam.self());

    const registry: Registry = {
      name,

      register(key: string, value: any): void {
        const pid = Beam.self();
        const monRef = Beam.monitor(pid, () => {
          unregisterEntry(name, key, pid);
        });

        const entry: InternalEntry = { pid, value, monitorRef: monRef };

        if (keysMode === "unique") {
          if (entries.has(key)) {
            Beam.demonitor(monRef);
            throw new BeamOtpError("already_started", `Key '${key}' is already registered`);
          }
          entries.set(key, entry);
        } else {
          const existing = entries.get(key) as InternalEntry[] | undefined;
          if (existing) {
            existing.push(entry);
          } else {
            entries.set(key, [entry]);
          }
        }
      },

      unregister(key: string): void {
        unregisterEntry(name, key, Beam.self());
      },

      lookup(key: string): [BeamPid, any][] | undefined {
        const entry = entries.get(key);
        if (!entry) return undefined;
        if (keysMode === "unique") {
          const e = entry as InternalEntry;
          return [[e.pid, e.value]];
        }
        return (entry as InternalEntry[]).map((e) => [e.pid, e.value]);
      },

      match(predicate: (key: string, value: any) => boolean): Map<string, [BeamPid, any][]> {
        const result = new Map<string, [BeamPid, any][]>();
        for (const [key, entry] of entries) {
          if (keysMode === "unique") {
            const e = entry as InternalEntry;
            if (predicate(key, e.value)) {
              result.set(key, [[e.pid, e.value]]);
            }
          } else {
            const list = entry as InternalEntry[];
            const matched = list.filter((e) => predicate(key, e.value));
            if (matched.length > 0) {
              result.set(key, matched.map((e) => [e.pid, e.value]));
            }
          }
        }
        return result;
      },

      count(): number {
        let total = 0;
        for (const entry of entries.values()) {
          total += Array.isArray(entry) ? entry.length : 1;
        }
        return total;
      },
    };

    return registry;
  },

  /**
   * Look up a registry by name (returns a proxy or throws).
   */
  lookup(name: string): Registry {
    const state = activeRegistries.get(name);
    if (!state) {
      throw BeamOtpError.noproc(`Registry '${name}'`);
    }

    // Return a proxy that operates on the same internal state
    const registry: Registry = {
      name,

      register(key: string, value: any): void {
        const pid = Beam.self();
        const monRef = Beam.monitor(pid, () => {
          unregisterEntry(name, key, pid);
        });
        const entry: InternalEntry = { pid, value, monitorRef: monRef };

        if (state.keysMode === "unique") {
          if (state.entries.has(key)) {
            Beam.demonitor(monRef);
            throw new BeamOtpError("already_started", `Key '${key}' is already registered`);
          }
          state.entries.set(key, entry);
        } else {
          const existing = state.entries.get(key) as InternalEntry[] | undefined;
          if (existing) existing.push(entry);
          else state.entries.set(key, [entry]);
        }
      },

      unregister(key: string): void {
        unregisterEntry(name, key, Beam.self());
      },

      lookup(key: string): [BeamPid, any][] | undefined {
        const entry = state.entries.get(key);
        if (!entry) return undefined;
        if (state.keysMode === "unique") {
          const e = entry as InternalEntry;
          return [[e.pid, e.value]];
        }
        return (entry as InternalEntry[]).map((e) => [e.pid, e.value]);
      },

      match(predicate: (key: string, value: any) => boolean): Map<string, [BeamPid, any][]> {
        const result = new Map<string, [BeamPid, any][]>();
        for (const [key, entry] of state.entries) {
          if (state.keysMode === "unique") {
            const e = entry as InternalEntry;
            if (predicate(key, e.value)) result.set(key, [[e.pid, e.value]]);
          } else {
            const list = entry as InternalEntry[];
            const matched = list.filter((e) => predicate(key, e.value));
            if (matched.length > 0) result.set(key, matched.map((e) => [e.pid, e.value]));
          }
        }
        return result;
      },

      count(): number {
        let total = 0;
        for (const entry of state.entries.values()) {
          total += Array.isArray(entry) ? entry.length : 1;
        }
        return total;
      },
    };

    return registry;
  },
};

// ── Internal helpers ───────────────────────────────────────────────

function unregisterEntry(registryName: string, key: string, pid: BeamPid): void {
  const state = activeRegistries.get(registryName);
  if (!state) return;

  if (state.keysMode === "unique") {
    const existing = state.entries.get(key) as InternalEntry | undefined;
    if (existing && existing.pid === pid) {
      Beam.demonitor(existing.monitorRef);
      state.entries.delete(key);
    }
  } else {
    const existing = state.entries.get(key) as InternalEntry[] | undefined;
    if (existing) {
      const idx = existing.findIndex((e) => e.pid === pid);
      if (idx !== -1) {
        Beam.demonitor(existing[idx].monitorRef);
        existing.splice(idx, 1);
        if (existing.length === 0) state.entries.delete(key);
      }
    }
  }
}
