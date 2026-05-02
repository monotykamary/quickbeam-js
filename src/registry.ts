/**
 * Registry — named process registry with unique/duplicate key modes.
 *
 * Entries are stored in an internal Map. The registry itself is
 * registered with Beam.register() for discovery by name.
 * Entry cleanup happens automatically via Beam.monitor().
 *
 * @module registry
 */

import { Beam, BeamPid, BeamRef } from "./beam-shim.js";
import { BeamOtpError } from "./errors.js";
import type { RegistryConfig, RegistryKeysMode } from "./types.js";

// ── Exported Registry interface ────────────────────────────────────

export interface Registry {
  readonly name: string;
  register(key: string, value: any): void;
  unregister(key: string): void;
  lookup(key: string): [BeamPid, any][] | undefined;
  match(predicate: (key: string, value: any) => boolean): Map<string, [BeamPid, any][]>;
  count(): number;
}

// ── Internal state ─────────────────────────────────────────────────

interface InternalEntry {
  pid: BeamPid;
  value: any;
  monitorRef: BeamRef;
}

const activeRegistries = new Map<string, {
  keysMode: RegistryKeysMode;
  entries: Map<string, InternalEntry | InternalEntry[]>;
}>();

// ── Namespaced Static API ──────────────────────────────────────────

export const Registry = {
  async start(name: string, config?: RegistryConfig): Promise<Registry> {
    const keysMode: RegistryKeysMode = config?.keys ?? "unique";
    const entries = new Map<string, InternalEntry | InternalEntry[]>();

    if (activeRegistries.has(name)) {
      throw BeamOtpError.alreadyStarted(`Registry '${name}'`);
    }

    activeRegistries.set(name, { keysMode, entries });

    // Register the current process under the registry name
    Beam.register(name);

    return makeRegistry(name, { keysMode, entries });
  },

  lookup(name: string): Registry {
    const state = activeRegistries.get(name);
    if (!state) {
      throw BeamOtpError.noproc(`Registry '${name}'`);
    }
    return makeRegistry(name, state);
  },
};

// ── Registry constructor ──────────────────────────────────────────

function makeRegistry(
  name: string,
  state: { keysMode: RegistryKeysMode; entries: Map<string, InternalEntry | InternalEntry[]> },
): Registry {
  const { keysMode, entries } = state;

  return {
    name,

    register(key: string, value: any): void {
      const pid = Beam.self();
      const monRef = Beam.monitor(pid, () => {
        unregisterEntry(entries, key, pid, keysMode);
      });

      const entry: InternalEntry = { pid, value, monitorRef: monRef };

      if (keysMode === "unique") {
        if (entries.has(key)) {
          Beam.demonitor(monRef);
          throw new BeamOtpError("BeamOtpError:already_started", `Key '${key}' is already registered`);
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
      unregisterEntry(entries, key, Beam.self(), keysMode);
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
}

// ── Internal helpers ───────────────────────────────────────────────

function unregisterEntry(
  entriesMap: Map<string, InternalEntry | InternalEntry[]>,
  key: string,
  pid: BeamPid,
  keysMode: RegistryKeysMode,
): void {
  if (keysMode === "unique") {
    const existing = entriesMap.get(key) as InternalEntry | undefined;
    if (existing && pidsEqual(existing.pid, pid)) {
      Beam.demonitor(existing.monitorRef);
      entriesMap.delete(key);
    }
  } else {
    const existing = entriesMap.get(key) as InternalEntry[] | undefined;
    if (existing) {
      const idx = existing.findIndex((e) => pidsEqual(e.pid, pid));
      if (idx !== -1) {
        Beam.demonitor(existing[idx].monitorRef);
        existing.splice(idx, 1);
        if (existing.length === 0) entriesMap.delete(key);
      }
    }
  }
}

function pidsEqual(a: BeamPid, b: BeamPid): boolean {
  return (a as any).__beam_type__ === "pid" && (b as any).__beam_type__ === "pid"
    && ((a as any).id === (b as any).id || (a as any).__beam_data__ === (b as any).__beam_data__);
}
