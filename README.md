<h1 align="center">⚡ quickbeam-js</h1>

<p align="center">
  <strong>OTP patterns in JavaScript, on the BEAM.</strong><br />
  GenServer · Supervisor · Registry · Pool · Task · Application —<br />
  all in TypeScript, all async, all running on a battle-tested VM.
</p>

<p align="center">
  <a href="#installation"><strong>Install</strong></a> ·
  <a href="#tour"><strong>Tour</strong></a> ·
  <a href="https://github.com/monotykamary/quickbeam-js/tree/main/docs/SPEC.md"><strong>API</strong></a> ·
  <a href="https://github.com/monotykamary/quickbeam-js/tree/main/docs/COOKBOOK.md"><strong>Cookbook</strong></a>
</p>

---

## The elevator pitch

You write JavaScript. You want Erlang's reliability — self-healing processes, supervision trees, message-passing resilience. **quickbeam-js** gives you exactly that.

```ts
import { GenServer, Supervisor, Pool, Registry, Application } from "quickbeam-js";

// A GenServer is just a class with a few lifecycle methods
class Counter extends GenServer {
  async init() {
    return { count: 0 };               // initial state
  }

  async handleCall("inc", [by], state) {
    const next = state.count + by;
    return { reply: next, state: { count: next } };
  }

  async handleCall("get", [], state) {
    return { reply: state.count, state };
  }

  async handleCast("reset", [], _state) {
    console.log("resetting…");
    return { state: { count: 0 } };
  }
}

// A supervisor restarts workers on failure — automatically
const sup = await Supervisor.start({
  strategy: "one_for_one",
  children: [
    { id: "cnt", start: () => Counter.startLink({ name: "my_counter" }) },
  ],
});

// Call it — like GenServer.call/2 in Elixir, but JS-native
const n = await GenServer.call("my_counter", "inc", [3]);
console.log(n); // 3

// Cast it — fire and forget
GenServer.cast("my_counter", "reset", []);
```

That's it. No Elixir modules. No `.ex` files. The only Elixir you need is the bootstrap line that starts QuickBEAM.

---

## Installation

### Prerequisites

- **Elixir ≥ 1.17** — QuickBEAM runs on the BEAM VM
- **Node.js ≥ 18** — for `npm install` and TypeScript tooling

### Step 1: Add QuickBEAM to your Elixir project

In `mix.exs`:

```elixir
defp deps do
  [
    {:quickbeam, "~> 0.10"},
    {:quickbeam_js, "~> 0.1"}   # optional Elixir helpers
  ]
end
```

Run `mix deps.get`.

### Step 2: Install the JS library

```bash
npm install quickbeam-js
```

This gets you TypeScript types (`import { GenServer } from "quickbeam-js"`) and source files.

### Step 3: Choose your integration path

You have two options:

#### Path A: Bundle your app + quickbeam-js together (recommended)

Wrap your entry point and let QuickBEAM's OXC bundler resolve imports through `node_modules`:

```elixir
# lib/my_app/bundle.ex
defmodule MyApp.Bundle do
  @app_js QuickBEAM.JS.bundle_file!("assets/js/app.ts", drop_console: false)
  def app_js, do: @app_js
end
```

```ts
// assets/js/app.ts — your entry point
import { Application, GenServer, Supervisor, Pool } from "quickbeam-js";

class Worker extends GenServer {
  async init() { return { count: 0 }; }
  async handleCall("work", [data], state) {
    const result = await processJob(data);
    return { reply: result, state: { count: state.count + 1 } };
  }
}

Application.start({
  id: "my_app",
  env: { port: 8080 },
  supervisor: {
    strategy: "one_for_one",
    children: [
      { id: "pool", start: () => Pool.start({ name: "workers", size: 4, child: Worker }) },
    ],
  },
});
```

Now in your Elixir supervision tree:

```elixir
children = [
  {QuickBEAM, name: :app, script: MyApp.Bundle.app_js()}
]
```

The bundler reads `assets/js/app.ts`, follows every `import`, inlines all of quickbeam-js, and produces a single JS string — ready for the BEAM.

#### Path B: Drop in the pre-built bundle (quickstart)

The npm package ships a pre-built single-file bundle at `node_modules/quickbeam-js/dist/quickbeam-js.bundle.js`.
Copy it into your project and load it directly:

```elixir
# In your supervision tree:
children = [
  {QuickBEAM, name: :app, script: "priv/quickbeam-js.bundle.js"}
]
```

The bundle sets `globalThis.QuickbeamJs`, so your own scripts can reference it:

```js
// priv/my_script.js — loaded in a second QuickBEAM runtime
const { GenServer, Supervisor } = QuickbeamJs;

class Counter extends GenServer {
  async init() { return { count: 0 }; }
  async handleCall("inc", [], state) {
    const next = state.count + 1;
    return { reply: next, state: { count: next } };
  }
}

await GenServer.startLink(Counter, { name: "counter" });
const n = await GenServer.call("counter", "inc", []);
console.log(n); // 1
```

#### Bonus: Use the Elixir helpers

If you added `{:quickbeam_js, "~> 0.1"}` to your deps, you get convenience functions:

```elixir
# Shortcut for the pre-built bundle path:
{QuickBEAM, name: :app, script: QuickbeamJs.prebuilt_bundle_path()}

# Or bundle your own entry with error handling:
@js QuickbeamJs.bundle_app!("assets/js/app.ts")
```

> **Which path?** Use Path A for production apps — you get tree-shaking, TypeScript checking, and your app and quickbeam-js are one optimised bundle. Use Path B for prototyping and quick experiments.

### 🤖 AI‑assisted setup

Copy this prompt into Claude, ChatGPT, Cursor, or any other AI coding tool.
It will scaffold an entire quickbeam-js project in one shot — no Elixir knowledge needed.

<details>
<summary><strong>📋 Click to copy the setup prompt</strong></summary>

```text
Set up a new QuickBEAM + quickbeam-js project called "my_app" in the current
directory. Follow these steps exactly:

1. SYSTEM CHECK
   - If Elixir is not available, install it via mise:
     - If mise is not installed: curl https://mise.run | sh
     - Then: mise install elixir@latest && mise use elixir@latest
   - Verify: elixir --version outputs Elixir >= 1.17
   - If Node.js is not available: mise install node@lts && mise use node@lts

2. PROJECT SCAFFOLDING
   - Run: mix new my_app --sup
   - cd my_app

3. DEPENDENCIES
   - Add to mix.exs deps:
       {:quickbeam, "~> 0.10"},
       {:quickbeam_js, "~> 0.1"}
   - Run: mix deps.get
   - Run: npm init -y && npm install quickbeam-js typescript
   - Create tsconfig.json with target ES2022, strict mode

4. APP ENTRY POINT
   - Create assets/js/app.ts:
     ```typescript
     import { Application, GenServer, Supervisor, Pool } from "quickbeam-js";

     class Worker extends GenServer {
       async init(args: { id: number }) {
         return { id: args.id, processed: 0 };
       }
       async handleCall("work", [job], state) {
         const result = `worker ${state.id} processed: ${job}`;
         return { reply: result, state: { ...state, processed: state.processed + 1 } };
       }
     }

     Application.start({
       id: "my_app",
       env: { port: 4000 },
       supervisor: {
         strategy: "one_for_one",
         children: [
           { id: "pool", start: () => Pool.start({
               name: "workers", size: 4, child: Worker, childArgs: { id: 0 }
           })},
         ],
       },
     });
     ```

5. BUNDLER MODULE
   - Create lib/my_app/bundle.ex:
     ```elixir
     defmodule MyApp.Bundle do
       @app_js QuickBEAM.JS.bundle_file!("assets/js/app.ts", drop_console: false)
       def app_js, do: @app_js
     end
     ```

6. SUPERVISION TREE
   - In lib/my_app/application.ex, add QuickBEAM to the children list:
     ```elixir
     children = [
       {QuickBEAM, name: :app, script: MyApp.Bundle.app_js()}
     ]
     ```

7. VERIFY
   - Run: mix compile --force
   - Run: iex -S mix
   - The app should boot without errors
   - The pool of 4 workers is now running on the BEAM

8. DONE
   - Print a summary of what was created and how the user can interact with it
```

</details>

> Replace `"my_app"` with your project name and adjust `Worker` to do your actual work. The scaffolded project compiles at build time — your entire app + quickbeam-js becomes one JS string, loaded onto the BEAM.

---

## Tour

Every feature below runs inside QuickBEAM — a real BEAM process gets spawned, monitored, and messaged. The TypeScript types are exact; the examples compile.

### 1. GenServer — the core pattern

GenServer is the foundation. It's a long-lived process with synchronous `call`, asynchronous `cast`, and a `handleInfo` hook for arbitrary messages.

```ts
class Cache extends GenServer {
  async init(args: { ttl: number }) {
    return { ttl: args.ttl, entries: new Map() };
  }

  async handleCall("get", [key], state) {
    const entry = state.entries.get(key);
    if (!entry) return { reply: undefined, state };
    if (Date.now() - entry.ts > state.ttl) {
      state.entries.delete(key);
      return { reply: undefined, state };
    }
    return { reply: entry.value, state };
  }

  async handleCall("set", [key, value], state) {
    state.entries.set(key, { value, ts: Date.now() });
    return { reply: "ok", state };
  }

  // handleInfo catches everything that's not a call or cast —
  // system messages, direct Beam.send(), monitor exits, etc.
  async handleInfo(msg: { type: "evict_stale" }, state) {
    const cutoff = Date.now() - state.ttl;
    for (const [k, v] of state.entries) {
      if (v.ts < cutoff) state.entries.delete(k);
    }
    return { state };
  }

  async terminate(reason, state) {
    console.log("cache shutting down:", reason, `had ${state.entries.size} entries`);
  }
}

const pid = await GenServer.startLink(Cache, { name: "cache", args: { ttl: 60000 } });

await GenServer.call("cache", "set", ["user:42", { name: "Alice" }]);
const user = await GenServer.call("cache", "get", ["user:42"]);
// => { name: "Alice" }
```

### 2. Supervisor — crash recovery, automatically

Supervisors watch children via BEAM monitors. When a child exits, the supervisor restarts it according to the strategy — no polling, no health checks, no `try/catch` wrappers. The VM tells you the instant it's down.

```ts
class Worker extends GenServer {
  async init(id: string) {
    return { id, processed: 0 };
  }

  async handleCall("work", [data], state) {
    // If this throws, the BEAM notifies the supervisor.
    // The supervisor restarts the GenServer — fresh state, ready to go.
    const result = await riskyOperation(data);
    return { reply: result, state: { ...state, processed: state.processed + 1 } };
  }
}

const sup = await Supervisor.start({
  strategy: "one_for_one",       // only restart the crashed child
  max_restarts: 5,               // at most 5 restarts…
  max_seconds: 10,               // …in a 10-second window
  children: [
    {
      id: "worker1",
      start: () => Worker.startLink({ name: "w1", args: "worker-1" }),
      restart: "permanent",      // always restart
    },
    {
      id: "cache",
      start: () => Cache.startLink({ name: "cache", args: { ttl: 30000 } }),
      restart: "transient",      // restart only on abnormal exit
      shutdown: "infinity",      // wait forever during graceful shutdown
    },
    {
      id: "one-shot",
      start: () => OneShot.startLink({ name: "os" }),
      restart: "temporary",      // never restart
    },
  ],
});

// Dynamic children at runtime
await Supervisor.startChild(sup, {
  id: "worker2",
  start: () => Worker.startLink({ name: "w2", args: "worker-2" }),
});

// Terminate on demand
await Supervisor.terminateChild(sup, "worker2");
```

**Strategies:**

| Strategy | On child crash… |
|----------|------------------|
| `one_for_one` | Restart only the failed child |
| `one_for_all` | Restart **every** child |
| `rest_for_one` | Restart the failed child and all started after it |

### 3. Registry — process discovery

The registry maps names to PIDs. When a registered process exits, its entry is automatically removed — no stale references.

```ts
const reg = await Registry.start("users");

// Register
const alice = await UserSession.startLink({ name: "alice" });
reg.register("alice", alice, { role: "admin" });

// Look up
const [pid, meta] = reg.lookup("alice");
// pid = <0.123.0>, meta = { role: "admin" }
await GenServer.call(pid, "get_profile", []);

// Match by pattern
for (const [pid, meta] of reg.match((key, _val) => key.startsWith("admin:"))) {
  Beam.send(pid, { type: "alert", text: "Deploy starting" });
}

// Duplicate keys for pub/sub groups
const rooms = await Registry.start("rooms", { keys: "duplicate" });
rooms.register("room:lobby", bob);
rooms.register("room:lobby", charlie);
// => both bob and charlie are under "room:lobby"
```

### 4. Pool — worker checkout, with backpressure

A fixed-size pool of GenServer workers. Checkout blocks when the pool is exhausted; checkin returns a worker to the idle queue. Built on top of a supervisor, so dead workers are automatically replaced.

```ts
class Renderer extends GenServer {
  async handleCall("render", [template, data], state) {
    const html = compile(template, data);     // runs inside QuickBEAM's real DOM
    return { reply: html, state };
  }
}

const pool = await Pool.start({
  name: "renderers",
  size: 4,                // 4 CSS-renderer processes
  child: Renderer,
  strategy: "fifo",       // or "lifo" for most-recently-used
});

// Checkout → use → checkin (bare metal)
const worker = await pool.checkout();
const html = await GenServer.call(worker, "render", ["home", { user: "alice" }]);
pool.checkin(worker);

// Transaction — auto-checkin, even on throw
const html = await pool.transaction(async (worker) => {
  return await GenServer.call(worker, "render", ["home", { user: "bob" }]);
});

// Inspect
pool.status(); // { size: 4, active: 2, idle: 2, overflow: 0 }
```

### 5. Task — async/await one‑shots

Spawn a process to do one thing, then await the result. Fire-and-forget is one method call away.

```ts
// Await a result
const ref = Task.async(() => fetchJson("https://api.example.com/data"));
const data = await Task.await(ref, 10_000);   // timeout after 10s

// Cancel if needed
ref.cancel();

// Fire and forget — no await required
Task.start(() => sendAnalytics("page_view", { path: "/home" }));
```

### 6. Application — the top-level boot

Wrap your supervision tree in an application. It's the entry-point you hand to QuickBEAM's Elixir bootstrap.

```ts
import { Application } from "quickbeam-js";

Application.start({
  id: "my_app",
  env: { port: 8080, log_level: "debug" },

  supervisor: {
    strategy: "one_for_one",
    children: [
      { id: "registry", start: () => Registry.start("app_registry") },
      {
        id: "pool",
        start: () => Pool.start({
          name: "workers",
          size: 8,
          child: MyWorker,
        }),
      },
      {
        id: "api",
        start: () => ApiServer.startLink({ name: "api", args: { port: 8080 } }),
      },
    ],
  },
});
```

### 7. Error handling — `_tag` discriminated unions

Every quickbeam-js error extends the native `Error` with a `_tag` property — a string literal that TypeScript can narrow. Chain causes like Go's `%w`, walk them with `findCause`.

```ts
import { BeamOtpError, findCause } from "quickbeam-js";

class DbError extends Error {
  constructor(public readonly sql: string, cause: Error) {
    super(`DB error: ${sql}`, { cause });
    this.name = "DbError";
  }
}

try {
  const data = await GenServer.call("nonexistent", "get", []);
} catch (err) {
  // Narrow by _tag — zero ambiguity
  if (err instanceof BeamOtpError && err._tag === "BeamOtpError:noproc") {
    console.log("Nobody's home. Starting fallback…");
  }

  // Walk the cause chain to find root
  const dbErr = findCause(err, DbError);
  if (dbErr) {
    console.error("Offending query:", dbErr.sql);
  }

  // Or: err.findCause(DbError) if it's already a BeamOtpError
}
```

**All error tags:**

| `_tag` | When |
|--------|------|
| `BeamOtpError:timeout` | Call / checkout deadline exceeded |
| `BeamOtpError:exit` | Target process exited mid-call |
| `BeamOtpError:noproc` | No process registered under that name |
| `BeamOtpError:already_started` | Name already taken |
| `BeamOtpError:not_found` | Child or registry key not found |
| `BeamOtpError:shutdown` | Supervisor is shutting down |
| `BeamOtpError:restart_limit` | Too many restarts too fast |

### 8. Utilities — batteries included

```ts
import { sleep, retry, withTimeout } from "quickbeam-js";

// Non-blocking sleep (yields to the BEAM scheduler)
await sleep(100);

// Retry with exponential backoff
const result = await retry(
  () => flakyApiCall(),
  { maxAttempts: 5, baseDelayMs: 50, maxDelayMs: 2000 },
);

// Timeout any promise
const data = await withTimeout(
  () => fetch("https://slow.example.com").then(r => r.json()),
  3000,
  "slow-http-call",
);
// throws BeamOtpError:timeout if > 3s
```

### 9. Low‑level Beam primitives — full control

quickbeam-js re‑exports QuickBEAM's entire `Beam.*` API. When you don't need OTP wrappers, go direct:

```ts
import { Beam } from "quickbeam-js";

// Identity
const self = Beam.self();                 // opaque BeamPid object

// Spawn a raw process (script string — QuickBEAM native)
const pid = Beam.spawn(`
  Beam.onMessage((msg) => console.log("child got:", msg));
`);

// Raw message passing
Beam.send(pid, { type: "poke" });
Beam.onMessage((msg) => console.log("received:", msg));

// Monitor — get notified when a process dies
Beam.monitor(pid, (reason) => {
  console.log("process exited with:", reason);
});

// Links — bidirectional crash propagation
Beam.link(pid);    // if they crash, I crash
Beam.unlink(pid);  // severed

// Name registration
Beam.register("my_service");             // registers self
const found = Beam.whereis("my_service"); // PID or null

// Generate unique references
const ref = Beam.makeRef();

// Inspect
Beam.inspect(pid); // "#PID<0.123.0>"

// Time
Beam.sleep(50);
Beam.nanoseconds();

// Cluster
Beam.nodes(); // [:"app@host"]

// Cross-runtime calls
const result = await Beam.call("service@other", "get_state");

// Elixir ↔ JS bridge (from the Elixir side)
QuickBEAM.set_global(runtime, "config", %{port: 3000});
// …in JS:
// config.port === 3000
```

---

## How it works

QuickBEAM embeds QuickJS (a full ES2022 engine) into the BEAM, then bridges JS processes to Erlang processes. quickbeam-js is a pure‑JavaScript library that sits on top of that bridge, providing the same abstractions you'd find in Elixir's OTP.

```
┌──────────────────────────────────────────────────┐
│ quickbeam-js (TypeScript)                        │
│   Supervisor · GenServer · Pool · Registry · …   │
├──────────────────────────────────────────────────┤
│ QuickBEAM (Zig + QuickJS + lexbor)               │
│   Beam.spawn · Beam.send · Beam.monitor · …      │
├──────────────────────────────────────────────────┤
│ BEAM VM (Erlang/OTP)                             │
│   Processes · Links · Monitors · Message Queues  │
└──────────────────────────────────────────────────┘
```

## What it is not

- **Not a new JS engine.** It runs on QuickBEAM's embedded QuickJS.  
- **Not an Elixir library.** You don't write `.ex` files to use it (just the one bootstrap line).  
- **Not a framework.** Use the pieces you need — raw `Beam.*`, a single `GenServer`, or a full `Application` tree.

---

## Testing

Unit tests run against a mock BEAM implementation — no QuickBEAM required:

```bash
npm test           # 61 tests, pure JS
npx tsc --noEmit   # strict type check
```

Integration tests run against a real QuickBEAM runtime — this is the gold standard:

```bash
mix test           # 19 E2E tests on the real BEAM
```

---

## License

MIT © [monotykamary](https://github.com/monotykamary)
