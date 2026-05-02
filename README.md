# beam-otp

OTP patterns in JavaScript, on the BEAM.

QuickBEAM gives JavaScript access to Erlang/OTP primitives — processes, monitors, links, message passing. beam-otp turns those primitives into the same high-level patterns Elixir developers rely on: supervisors with restart strategies, GenServers with call/cast, registries, pools, and applications.

The only Elixir you write:

```elixir
children = [{QuickBEAM, name: :root, script: "priv/js/app.js"}]
```

Everything else is JavaScript.

## Why

QuickBEAM runs JS on the BEAM, but it's managed from Elixir. Every runtime is an Elixir GenServer. Every pool is an Elixir supervisor. Every handler registration is an Elixir map. This works — but it forces JS developers into Elixir for lifecycle management, and it splits the mental model: JS owns the logic, Elixir owns the lifecycle.

beam-otp asks: **what if JS owned both?**

```javascript
import { Supervisor, GenServer, Registry, Pool } from "beam-otp";

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

- **Not a new JS engine.** beam-otp runs on QuickBEAM, which runs QuickJS. Arc is building a BEAM-native JS engine from scratch; beam-otp wraps the existing one.
- **Not a replacement for Elixir supervision.** Under the hood, every JS runtime is still a BEAM GenServer. beam-otp just lets you configure and manage it from JS.
- **Not a framework.** It's a library. You use the pieces you need.

## Installation

```bash
# QuickBEAM is the runtime dependency
mix deps.get   # {:quickbeam, "~> 0.7"}

# beam-otp is a JS library, shipped as npm package or bundled via QuickBEAM
npm install beam-otp
```

## Quick start

```javascript
import { Supervisor, GenServer } from "beam-otp";

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
