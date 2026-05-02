# Architecture

## The Problem

QuickBEAM gives JS access to BEAM primitives, but the orchestration layer is Elixir. A typical QuickBEAM app looks like:

```elixir
# application.ex — Elixir manages JS lifecycles
children = [
  {QuickBEAM, name: :renderer, script: "priv/js/render.js", handlers: %{
    "render" => fn [page] -> Renderer.render(page) end,
  }},
  {QuickBEAM.ContextPool, name: MyApp.Pool, size: 4},
  # ...more Elixir supervision...
]
```

The JS code inside those runtimes has **no say** in how it's supervised. It can't restart itself. It can't start siblings. It can't define its own supervision tree. Elixir owns the lifecycle; JS is a guest.

This works for simple cases (one runtime, one script). It breaks when:

- A JS runtime needs to **spawn and supervise** child runtimes (e.g., a pool that grows)
- The **restart strategy** is domain logic that belongs in JS (e.g., "on crash, re-read config from disk")
- The app has **many interdependent JS runtimes** and managing them from Elixir is accidental complexity
- The developer is **a JS developer**, not an Elixir developer

## The Idea

**JS manages JS, through BEAM primitives.**

QuickBEAM's `Beam.*` API already exposes everything needed:
- `Beam.spawn` — create a new JS runtime as a BEAM process
- `Beam.monitor` / `Beam.demonitor` — observe process exits
- `Beam.link` / `Beam.unlink` — crash propagation
- `Beam.send` / `Beam.onMessage` — message passing
- `Beam.call` / `Beam.callSync` — synchronous RPC
- `Beam.register` / `Beam.whereis` — name registration

quickbeam-js takes these low-level primitives and builds the same patterns Elixir uses: Supervisor, GenServer, Registry, Pool, Task, Application. The patterns are identical; the language is JS.

## OTP → JS Mapping

| OTP Concept | Elixir | quickbeam-js JS |
|---|---|---|
| Process | `spawn` / `spawn_link` | `Beam.spawn` |
| Named process | `Process.register` | `Beam.register` |
| Monitor | `Process.monitor` | `Beam.monitor` |
| Link | `Process.link` | `Beam.link` |
| Message send | `send(pid, msg)` | `Beam.send(pid, msg)` |
| Message receive | `receive do` | `Beam.onMessage(cb)` |
| GenServer | `use GenServer` | `class extends GenServer` |
| Supervisor | `use Supervisor` | `Supervisor.start(spec)` |
| Registry | `Registry.register` | `Registry.register(name, key, pid)` |
| Pool | `:poolboy` / `Poolboy` | `Pool.start(spec)` |
| Task | `Task.async` / `Task.await` | `Task.async(fn)` / `Task.await(ref)` |
| Application | `def application` | `Application.start(config)` |

## How It Works

### Bootstrap

The entry point is always one Elixir line:

```elixir
children = [{QuickBEAM, name: :quickbeam_js_root, script: "priv/js/app.js"}]
```

`app.js` imports quickbeam-js and starts the root supervisor:

```javascript
import { Application } from "quickbeam-js";
import config from "./app.config.js";

Application.start(config);
```

From this point, no Elixir is involved. The root JS runtime becomes the root supervisor, spawning and monitoring children via `Beam.*`.

### Supervisor

A Supervisor is a JS object that:
1. Holds a list of child specs `{id, start, restart, shutdown, type}`
2. Starts each child via `child.start()`, which calls `Beam.spawn` internally
3. Monitors each child via `Beam.monitor(childPid, onExit)`
4. On child exit, applies the restart strategy:
   - `one_for_one` — restart only the crashed child
   - `one_for_all` — restart all children (in start order)
   - `rest_for_one` — restart the crashed child and all started after it
5. Enforces `max_restarts` / `max_seconds` (if more than N restarts in M seconds, the supervisor itself exits)
6. On its own exit, sends shutdown signals to all children (in reverse start order)

The supervisor state (child PIDs, restart timestamps, start order) lives in JS closures. No ETS, no Elixir process dictionary. The supervisor IS the QuickBEAM runtime process — it monitors children and reacts to exit messages in its `Beam.onMessage` loop.

### GenServer

A GenServer is a JS class with lifecycle methods:

```typescript
abstract class GenServer {
  async init(args): Promise<State>           // called at startup
  async handleCall(msg, from, state): Promise<{reply, state}>
  async handleCast(msg, state): Promise<state>
  async handleInfo(msg, state): Promise<state>
  async terminate(reason, state): Promise<void>
}
```

Internally, `GenServer.startLink` does:
1. `Beam.spawn` a new JS runtime running the GenServer loop
2. `Beam.register` it under the given name
3. The loop receives messages via `Beam.onMessage` and dispatches to the appropriate handler
4. `GenServer.call(name, msg)` sends a `{type: "call", ref, msg}` to the named process and awaits a `{type: "reply", ref, result}` response
5. `GenServer.cast(name, msg)` sends a `{type: "cast", msg}` without waiting

### Registry

A Registry is a JS object backed by `Beam.register`/`Beam.whereis` + an internal `Map`:

```typescript
class Registry {
  start(name: string): Registry
  register(name: string, key: string, pid: BeamPid): void
  unregister(name: string, key: string): void
  lookup(name: string, key: string): BeamPid | undefined
  match(name: string, pattern): Map<key, BeamPid>
}
```

Each registration is a `Beam.register` call. Lookups use `Beam.whereis`. The Registry also monitors registered processes and auto-unregisters on exit.

### Pool

A Pool is a fixed-size group of supervised workers with checkout/checkin:

```typescript
class Pool {
  start(spec: { name, size, child: typeof GenServer }): Pool
  checkout(): Promise<BeamPid>
  checkin(pid: BeamPid): void
  status(): { idle: number, in_use: number, size: number }
}
```

Internally, a Pool is a Supervisor with `size` children. Idle workers go into a queue. `checkout` dequeues; `checkin` enqueues. If a worker crashes while checked out, the supervisor restarts it and the checkout is invalidated (the consumer gets a monitor exit).

### Task

Tasks are fire-and-forget or awaited one-shot computations:

```typescript
class Task {
  static async(fn: () => Promise<T>): TaskRef<T>   // spawn and return ref
  static await(ref: TaskRef<T>, timeout?): T        // block for result
}
```

`Task.async` spawns a new runtime via `Beam.spawn`, monitors it, and returns a ref. The spawned runtime runs the function, then sends the result back. `Task.await` blocks (via message receive) until the result arrives or timeout.

## Comparison with Arc

Arc (github.com/alii/arc) and quickbeam-js share a vision: JS on the BEAM with OTP patterns. They differ fundamentally in approach:

| | quickbeam-js | Arc |
|---|---|---|
| **Engine** | QuickJS (C, NIF) | Custom VM (Gleam, BEAM bytecode) |
| **Process model** | OS thread per runtime, contexts share threads | BEAM process per `Arc.spawn` |
| **JS conformance** | Full ECMAScript 2023 (QuickJS) | Incremental (test262 in progress) |
| **Crash isolation** | Context-level (NIF crash = VM crash) | Process-level (BEAM guarantees) |
| **Memory per instance** | ~58KB (bare) / ~429KB (full APIs) | ~2-4KB (BEAM heap) |
| **GC** | QuickJS per-heap (stop-the-world per context) | BEAM per-process (never global) |
| **Web APIs** | Full suite (fetch, DOM, WebSocket, ...) | None yet |
| **TypeScript** | Built-in OXC toolchain | None |
| **npm** | Built-in client | None |
| **Ready for production** | Today (QuickBEAM 0.7+) | Research stage |
| **10K instances** | ~570MB bare / ~4.2GB full | ~40MB |

**quickbeam-js is pragmatic**: wrap a battle-tested JS engine and add OTP patterns in JS. Available today, full JS conformance, rich APIs. Tradeoff: OS threads and C heaps don't scale like BEAM processes.

**Arc is pure**: build a JS engine that compiles to BEAM bytecode. Every JS process is a BEAM process with all the guarantees. Tradeoff: years from completeness, no Web APIs, no npm.

They're complementary, not competitive. quickbeam-js is what you use today. Arc is what the future looks like if the BEAM-native engine matures. A future migration path from quickbeam-js to Arc is architecturally clean — both expose OTP patterns from JS, just with different runtimes underneath.

## Limits

### The NIF Crash Problem

QuickBEAM contexts run QuickJS on OS threads. A segfault in QuickJS (or a native dependency) crashes the BEAM VM. quickbeam-js can't fix this — it's a QuickBEAM/Zig constraint. Mitigations:
- `memory_limit` and `max_reductions` prevent runaway code
- `apis: false` sandboxes reduce attack surface
- Future: QuickBEAM could run contexts in separate OS processes (like RabbitMQ's client connection process isolation)

### The Thread Ceiling

Each QuickBEAM runtime gets an OS thread. At 10K runtimes you have 10K threads (~30GB RAM). Context pools mitigate this (4 threads, 10K lightweight contexts), but contexts share an interpreter — no true parallel JS execution within one thread. For parallelism you need runtimes, and runtimes need threads. This is the fundamental scaling limit.

### The Single-Bootstrap Constraint

quickbeam-js requires one Elixir line to start. If that root runtime crashes, the supervisor tree dies with it. Elixir's application supervisor restarts the root, but the in-memory supervisor state is lost. Mitigation: `Application.start` can persist child specs to ETS or SQLite, and `init` re-reads them.

### No Hot Code Upgrades

Elixir can hot-swap module code. quickbeam-js can't — JS code is loaded at startup. A supervisor restart loads fresh code, but that's a process restart, not a hot upgrade. Future: QuickBEAM's `:script` option could watch for file changes and self-reload.
