# quickbeam-js

OTP patterns in JavaScript, on the BEAM.

QuickBEAM gives JavaScript access to Erlang/OTP primitives — processes, monitors, links, message passing. quickbeam-js turns those primitives into the same high-level patterns Elixir developers rely on: supervisors with restart strategies, GenServers with call/cast, registries, pools, and applications.

The only Elixir you write:

```elixir
children = [{QuickBEAM, name: :root, script: "priv/js/app.js"}]
```

Everything else is JavaScript.

## Why

QuickBEAM runs JS on the BEAM, but it's managed from Elixir. Every runtime is an Elixir GenServer. Every pool is an Elixir supervisor. Every handler registration is an Elixir map. This works — but it forces JS developers into Elixir for lifecycle management, and it splits the mental model: JS owns the logic, Elixir owns the lifecycle.

quickbeam-js asks: **what if JS owned both?**

```javascript
import { Supervisor, GenServer, Registry, Pool } from "quickbeam-js";

class Worker extends GenServer {
  async init() { return { tasks: 0 }; }
  async handleCall("run", [job], state) {
    const result = await processJob(job);
    return { reply: result, state: { ...state, tasks: state.tasks + 1 } };
  }
}

const app = Supervisor.start({
  strategy: "one_for_one",
  children: [
    { id: "registry", start: () => Registry.start("workers") },
    { id: "pool", start: () => Pool.start({ name: "workers", size: 4, child: Worker }) },
  ],
});
```

No Elixir modules. No split mental model. JS manages JS.

## What it is not

- **Not a new JS engine.** quickbeam-js runs on QuickBEAM, which runs QuickJS. Arc is building a BEAM-native JS engine from scratch; quickbeam-js wraps the existing one.
- **Not a replacement for Elixir supervision.** Under the hood, every JS runtime is still a BEAM GenServer. quickbeam-js just lets you configure and manage it from JS.
- **Not a framework.** It's a library. You use the pieces you need.

## Installation

```bash
# QuickBEAM is the runtime dependency
mix deps.get   # {:quickbeam, "~> 0.7"}

# quickbeam-js is a JS library, shipped as npm package or bundled via QuickBEAM
npm install quickbeam-js
```

## Low-level Beam primitives

quickbeam-js re-exports QuickBEAM's full `Beam.*` API. Use these directly when
you need fine-grained control — no OTP wrappers required.

```javascript
import { Beam } from "quickbeam-js";

// ── Process identity ──────────────────────────────────────────────
const self = Beam.self();
console.log("My PID:", self); // <0.123.0>

// ── Fire-and-forget messaging ─────────────────────────────────────
Beam.send(somePid, { type: "tick", payload: 42 });

// ── Receive messages (one handler per process) ────────────────────
Beam.onMessage((msg) => {
  console.log("got:", msg);
});

// ── Spawn a new process ───────────────────────────────────────────
const pid = await Beam.spawn(async () => {
  Beam.onMessage((msg) => console.log("child got:", msg));
  await Beam.sleep(1000);
});

// ── Monitor (get notified when a process exits) ───────────────────
const ref = Beam.monitor(pid, (exitedPid, reason) => {
  console.log(`process ${exitedPid} died:`, reason);
});
Beam.demonitor(ref); // cancel

// ── Name registration ─────────────────────────────────────────────
Beam.register("logger", Beam.self());
const loggerPid = Beam.whereis("logger");
Beam.unregister("logger");

// ── Links (bidirectional crash propagation) ───────────────────────
Beam.link(pid);    // if pid crashes, I crash too
Beam.unlink(pid);

// ── Exit signals ──────────────────────────────────────────────────
Beam.exitProcess(pid, "shutdown");
Beam.exit("normal"); // exit myself

// ── Cluster nodes ─────────────────────────────────────────────────
const nodes = Beam.nodes(); // [:"app@host"]
const result = await Beam.call("service@other", { type: "ping" });

// ── Transport closures across processes ───────────────────────────
// Beam.eval runs code or a closure in the context of a target process.
// This is how you inject behavior into another runtime at runtime.
const shared = { value: 0, name: "shared" };
await Beam.eval(childPid, (scope) => {
  scope.value = 42;
  Beam.onMessage((msg) => console.log("child received:", msg));
}, shared);
// `shared.value` is now 42 inside the child process

// Or pass the scope object directly (QuickBEAM serializes/transports it)
await Beam.eval(childPid, (scope) => {
  console.log("Booted with config:", scope.config);
  scope.onReady();
}, { config: { port: 8080 }, onReady: () => console.log("ready") });
```

All these primitives work both in production (against QuickBEAM's real
`globalThis.Beam`) and in unit tests (against the mock Beam).

## Quick start

```javascript
import { Supervisor, GenServer } from "quickbeam-js";

// 1. Define a worker
class Counter extends GenServer {
  async init() { return { count: 0 }; }
  async handleCall("inc", [_by], state) {
    const next = state.count + 1;
    return { reply: next, state: { count: next } };
  }
  async handleCall("get", [], state) {
    return { reply: state.count, state };
  }
}

// 2. Start a supervisor
const sup = Supervisor.start({
  strategy: "one_for_one",
  children: [
    { id: "counter1", start: () => Counter.startLink("counter1") },
  ],
});

// 3. Use it
const count = await GenServer.call("counter1", "inc", []);
// => 1
```

## License

MIT
