# API Specification

All APIs are async (return `Promise`). All runtime errors throw `BeamOtpError`. All PIDs are `BeamPid` opaque values from QuickBEAM.

---

## Supervisor

### Types

```typescript
interface ChildSpec {
  id: string;
  start: () => Promise<BeamPid>;
  restart?: "permanent" | "temporary" | "transient";  // default: "permanent"
  shutdown?: number | "infinity";                       // default: 5000 (ms)
  type?: "worker" | "supervisor";                       // default: "worker"
}

interface SupervisorConfig {
  strategy: "one_for_one" | "one_for_all" | "rest_for_one";
  children: ChildSpec[];
  max_restarts?: number;    // default: 3
  max_seconds?: number;    // default: 5
}

interface Supervisor {
  pid: BeamPid;
  children: Map<string, Child>;
  startChild(spec: ChildSpec): Promise<BeamPid>;
  terminateChild(id: string): Promise<void>;
  restartChild(id: string): Promise<BeamPid>;
  whichChildren(): ChildInfo[];
  count(): { specs: number, active: number, supervisors: number, workers: number };
}
```

### `Supervisor.start(config: SupervisorConfig): Promise<Supervisor>`

Starts a supervisor. Each child is started via `spec.start()` (which should call `Beam.spawn` internally). The supervisor monitors all children and applies the restart strategy on exit.

**Behavioral contract:**
- Children are started in order. If a child fails to start, previously started children are terminated in reverse order and the supervisor itself fails.
- On child exit:
  - `permanent`: always restart
  - `temporary`: never restart
  - `transient`: restart only if exit reason is not `:normal` / `:shutdown`
- Restart intensity: if more than `max_restarts` occur within `max_seconds`, the supervisor exits with reason `:shutdown`
- On supervisor shutdown, children are terminated in reverse start order, waiting up to `shutdown` ms per child before killing

```javascript
const sup = await Supervisor.start({
  strategy: "one_for_one",
  children: [
    { id: "db", start: () => Database.startLink("db"), shutdown: "infinity" },
    { id: "cache", start: () => Cache.startLink("cache"), restart: "transient" },
    { id: "api", start: () => ApiServer.startLink("api"), type: "supervisor" },
  ],
  max_restarts: 5,
  max_seconds: 10,
});
```

### `Supervisor.startChild(sup: Supervisor, spec: ChildSpec): Promise<BeamPid>`

Dynamically add a child to a running supervisor. The child is started and monitored.

### `Supervisor.terminateChild(sup: Supervisor, id: string): Promise<void>`

Terminate a child by ID. The child process is sent a shutdown signal. If `restart` is `"permanent"`, a new child is NOT automatically started (matches Elixir behavior — `terminateChild` stops and deletes the child spec).

### `Supervisor.restartChild(sup: Supervisor, id: string): Promise<BeamPid>`

Restart a previously terminated child. The child spec must still exist in the supervisor.

---

## GenServer

### Types

```typescript
interface GenServerState {}

interface CallResult<T = any> {
  reply: T;
  state: any;
}

interface CastResult {
  state: any;
}

interface InfoResult {
  state: any;
}

interface GenServerConfig {
  name?: string;          // register under this name
  args?: any;             // passed to init()
  timeout?: number;       // call timeout in ms (default: 5000)
  hibernate_after?: number; // idle ms before hibernation (default: infinity)
}

abstract class GenServer {
  // Lifecycle — override in subclass
  abstract init(args?: any): Promise<any>;
  handleCall(message: any, from: From, state: any): Promise<CallResult>;
  handleCast(message: any, state: any): Promise<CastResult>;
  handleInfo(message: any, state: any): Promise<InfoResult>;
  terminate(reason: any, state: any): Promise<void>;
  codeChange(oldVsn: any, state: any, extra: any): Promise<any>;
}
```

### `GenServer.startLink(cls: typeof GenServer, config?: GenServerConfig): Promise<BeamPid>`

Starts a GenServer. Internally:
1. Spawns a new JS runtime via `Beam.spawn`
2. Calls `cls.init(config.args)` to get initial state
3. Registers under `config.name` via `Beam.register` if provided
4. Enters the message loop: receive → dispatch → loop

```javascript
class Counter extends GenServer {
  async init() { return { count: 0 }; }
  async handleCall(msg, from, state) {
    if (msg === "inc") return { reply: ++state.count, state };
    if (msg === "get") return { reply: state.count, state };
    throw new Error(`unknown call: ${msg}`);
  }
}

const pid = await GenServer.startLink(Counter, { name: "counter" });
```

### `GenServer.call(target: string | BeamPid, message: any, timeout?: number): Promise<any>`

Synchronous call. Sends `{type: "call", ref: makeRef(), message}` to target. Blocks until a reply `{type: "reply", ref, result}` arrives or timeout. If the target exits, throws `BeamOtpError` with reason.

**Timeout default: 5000ms.** Throws `BeamOtpError("timeout")` on expiry.

```javascript
const count = await GenServer.call("counter", "inc");
```

### `GenServer.cast(target: string | BeamPid, message: any): void`

Asynchronous cast. Sends `{type: "cast", message}` to target. No reply, no confirmation.

```javascript
GenServer.cast("counter", { type: "reset", value: 0 });
```

### Message loop internals

The GenServer loop runs inside the spawned JS runtime:

```
Beam.onMessage((msg) => {
  switch (msg.type) {
    case "call":  handleCall(msg.message, msg.from, state) → send reply
    case "cast":  handleCast(msg.message, state)           → update state
    case "info":  handleInfo(msg.message, state)           → update state
    case "system": handleSystem(msg, state)                → (shutdown, etc.)
  }
})
```

`handleCall` MUST return `{reply, state}`. If the handler throws, the GenServer exits with reason `{:error, exception}`.

`handleCast` and `handleInfo` MUST return `{state}`. If the handler throws, the error is logged and the GenServer continues with the previous state (configurable: `throwOnCastError: true` exits instead).

---

## Registry

### Types

```typescript
interface RegistryConfig {
  keys?: "unique" | "duplicate";  // default: "unique"
}

class Registry {
  static start(name: string, config?: RegistryConfig): Promise<Registry>;
  register(key: string, value: any): void;
  unregister(key: string): void;
  lookup(key: string): [BeamPid, any] | undefined;        // {pid, value}
  match(pattern: (key: string, value: any) => boolean): Map<string, [BeamPid, any]>;
  count(): number;
}
```

### `Registry.start(name: string, config?: RegistryConfig): Promise<Registry>`

Starts a registry. If `keys: "unique"`, each key maps to one process. If `keys: "duplicate"`, multiple processes can register under the same key.

The registry monitors all registered processes. When a registered process exits, its entries are automatically removed.

```javascript
const reg = await Registry.start("sessions", { keys: "duplicate" });
await reg.register("room:lobby", { user: "alice" });
await reg.register("room:lobby", { user: "bob" });

// Broadcast to all processes in room:lobby
for (const [pid, value] of reg.match((k) => k.startsWith("room:"))) {
  Beam.send(pid, { type: "msg", from: "system", text: "hello" });
}
```

---

## Pool

### Types

```typescript
interface PoolConfig {
  name: string;
  size: number;
  child: typeof GenServer;
  childArgs?: any;
  strategy?: "fifo" | "lifo";  // default: "fifo"
  overflow?: number;            // default: 0
  max_overflow?: number;        // default: 0
}

interface Pool {
  pid: BeamPid;
  checkout(timeout?: number): Promise<BeamPid>;
  checkin(pid: BeamPid): void;
  status(): PoolStatus;
  transaction<T>(fn: (worker: BeamPid) => Promise<T>, timeout?: number): Promise<T>;
}

interface PoolStatus {
  size: number;
  active: number;
  idle: number;
  overflow: number;
}
```

### `Pool.start(config: PoolConfig): Promise<Pool>`

Starts a pool. Internally creates a Supervisor with `size` children. Idle workers go into a queue.

### `Pool.checkout(timeout?: number): Promise<BeamPid>`

Borrow a worker from the pool. Blocks if all workers are busy, up to `timeout` ms (default: 5000). Throws `BeamOtpError("timeout")` if no worker becomes available.

### `Pool.checkin(pid: BeamPid): void`

Return a worker to the pool. If the worker died while checked out, it's not returned — the supervisor will have already restarted it.

### `Pool.transaction(fn, timeout?): Promise<T>`

Checkout, run, checkin. Guarantees the worker is returned even if `fn` throws.

```javascript
const pool = await Pool.start({ name: "renderers", size: 4, child: Renderer });

const html = await pool.transaction(async (worker) => {
  return await GenServer.call(worker, { render: pageData });
});
```

---

## Task

### Types

```typescript
interface TaskRef<T = any> {
  pid: BeamPid;
  ref: BeamRef;
  /** Cancel the task (sends shutdown to the spawned process) */
  cancel(): void;
}

class Task {
  static async<T>(fn: () => Promise<T>): TaskRef<T>;
  static await<T>(ref: TaskRef<T>, timeout?: number): Promise<T>;
  static start(fn: () => Promise<void>): BeamPid;  // fire-and-forget
}
```

### `Task.async(fn): TaskRef`

Spawn a one-shot process. Returns a ref with `pid` and `ref`. The spawned process runs `fn`, then sends the result back.

### `Task.await(ref, timeout?): Promise<T>`

Block until the task completes. Throws `BeamOtpError("timeout")` on expiry. Throws the task's exception if the task threw.

```javascript
const ref = Task.async(() => fetchAndProcess(url));
const result = await Task.await(ref, 10_000);
```

### `Task.start(fn): BeamPid`

Fire-and-forget. Spawn a process, don't wait. Returns the PID.

---

## Application

### Types

```typescript
interface AppConfig {
  id: string;
  supervisor: SupervisorConfig;
  env?: Record<string, any>;
}

class Application {
  static start(config: AppConfig): Promise<Application>;
  static stop(app: Application): Promise<void>;
  static which(): Application[];
  getEnv(key: string): any;
  putEnv(key: string, value: any): void;
}
```

### `Application.start(config: AppConfig): Promise<Application>`

The top-level entry point. Called from `app.js` (the script the Elixir bootstrap runs). Starts the root supervisor, loads environment config.

```javascript
// priv/js/app.js
import { Application } from "quickbeam-js";

Application.start({
  id: "my_app",
  env: { port: 4000, db_path: "/data/app.db" },
  supervisor: {
    strategy: "one_for_one",
    children: [
      { id: "db", start: () => Db.startLink() },
      { id: "pool", start: () => Pool.start({ name: "workers", size: 4, child: Worker }) },
      { id: "api", start: () => ApiServer.startLink() },
    ],
  },
});
```

---

## Errors

```typescript
class BeamOtpError extends Error {
  code: "timeout" | "exit" | "noproc" | "already_started" | "not_found" | "shutdown" | "restart_limit";
  reason?: any;
}
```

| Code | When |
|---|---|
| `timeout` | Call or checkout exceeded deadline |
| `exit` | Target process exited during call |
| `noproc` | No process registered under the given name |
| `already_started` | Name already registered |
| `not_found` | Child or registry key not found |
| `shutdown` | Supervisor is shutting down |
| `restart_limit` | Supervisor exceeded max_restarts in max_seconds |

---

## Message Protocol

quickbeam-js uses a convention over `Beam.send`/`Beam.onMessage`:

```typescript
// GenServer call
{ type: "call", ref: BeamRef, from: BeamPid, message: any }

// GenServer call reply
{ type: "reply", ref: BeamRef, result: any }

// GenServer cast
{ type: "cast", message: any }

// GenServer info (anything not call/cast)
{ type: "info", message: any }

// System messages
{ type: "system", action: "shutdown" | "code_change", payload: any }

// Monitor exit
{ type: "exit", pid: BeamPid, reason: any }
```

All quickbeam-js messages are tagged with `type`. User-defined messages sent via `Beam.send` directly (bypassing GenServer) are received in `handleInfo`.
