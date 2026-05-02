# Cookbook

Common patterns implemented with beam-otp.

---

## 1. SSR Pool with Native DOM

Server-side rendering using QuickBEAM's built-in DOM (lexbor) + a pool of renderer workers.

```javascript
import { GenServer, Pool, Supervisor, Application } from "beam-otp";

class Renderer extends GenServer {
  async init() {
    return { rendered: 0 };
  }

  async handleCall({ render, data }, _from, state) {
    // QuickBEAM has a real DOM — no renderToString needed
    document.body.innerHTML = "";
    const app = createApp(data); // your framework
    app.mount(document.body);

    const html = document.body.innerHTML;
    return { reply: html, state: { ...state, rendered: state.rendered + 1 } };
  }
}

Application.start({
  id: "ssr",
  supervisor: {
    strategy: "one_for_one",
    children: [
      { id: "ssr_pool", start: () => Pool.start({
        name: "renderers",
        size: 4,
        child: Renderer,
      })},
    ],
  },
});
```

From Elixir (or another JS runtime):

```javascript
const pool = Pool.lookup("renderers");
const html = await pool.transaction(async (worker) => {
  return await GenServer.call(worker, { render: "home", data: { user: "alice" } });
});
```

---

## 2. LiveView Per-Connection Context

Each LiveView gets a lightweight JS context from a shared pool. The context runs user-specific logic (form validation, computed fields) and calls back to Elixir for persistence.

```javascript
import { GenServer, Pool, Registry } from "beam-otp";

class SessionLogic extends GenServer {
  async init({ userId }) {
    return { userId, cart: [], validation: {} };
  }

  async handleCall("validate", [field, value], state) {
    const errors = validateField(field, value, state);
    return { reply: errors, state: { ...state, validation: { ...state.validation, [field]: errors } } };
  }

  async handleCall("add_to_cart", [item], state) {
    const cart = [...state.cart, item];
    // Persist to Elixir
    await Beam.call("cart.update", state.userId, cart);
    return { reply: cart, state: { ...state, cart } };
  }

  async handleInfo({ type: "cart_sync", cart }, state) {
    // Elixir pushed a cart update from another session
    return { state: { ...state, cart } };
  }
}
```

From Elixir LiveView:

```elixir
def mount(_params, _session, socket) do
  {:ok, ctx} = QuickBEAM.Context.start_link(
    pool: MyApp.JSPool,
    handlers: %{"cart.update" => fn [user_id, cart] -> Cart.save(user_id, cart) end}
  )
  QuickBEAM.Context.eval(ctx, """
    import { SessionLogic } from "beam-otp";
    SessionLogic.startLink({ name: "session_#{pane_id}", args: { userId: "#{user_id}" } });
  """)
  {:ok, assign(socket, js: ctx)}
end
```

---

## 3. Rule Engine with Sandboxed Evaluation

User-defined business rules (pricing, validation, transforms) in sandboxed JS runtimes with `apis: false`, memory limits, and timeouts.

```javascript
import { GenServer, Pool } from "beam-otp";

class RuleWorker extends GenServer {
  async init() {
    return { rules: [] };
  }

  async handleCall({ eval: code, input }, _from, state) {
    try {
      // QuickBEAM memory_limit and max_reductions prevent runaway code
      const fn = new Function("input", code);
      const result = fn(input);
      return { reply: { ok: true, result }, state };
    } catch (e) {
      return { reply: { ok: false, error: e.message }, state };
    }
  }

  async handleCast({ load_rules, rules }, state) {
    return { state: { ...state, rules } };
  }
}

// Start pool with minimal per-worker resources
const pool = await Pool.start({
  name: "rule_workers",
  size: 2,
  child: RuleWorker,
});

// Evaluate a rule
const result = await pool.transaction(async (worker) => {
  return await GenServer.call(worker, {
    eval: "return input.price * input.quantity * (input.discount || 1)",
    input: { price: 29.99, quantity: 3, discount: 0.9 },
  });
});
// => { ok: true, result: 80.97 }
```

Corresponding Elixir bootstrap sets memory limits:

```elixir
children = [
  {QuickBEAM.ContextPool, name: :rule_pool, size: 2, memory_limit: 512_000, max_reductions: 100_000},
  {QuickBEAM, name: :beam_otp_root, script: "priv/js/app.js"},
]
```

---

## 4. Real-time Chat Room

Each chat room is a supervised GenServer. Join/leave/broadcast use the Registry.

```javascript
import { GenServer, Supervisor, Registry, Application } from "beam-otp";

class Room extends GenServer {
  async init({ roomId }) {
    const reg = Registry.lookup("rooms");
    await reg.register(roomId, Beam.self());
    return { roomId, members: new Set() };
  }

  async handleCall("join", [userId], state) {
    state.members.add(userId);
    return { reply: [...state.members], state };
  }

  async handleCast({ type: "message", from, text }, state) {
    // Broadcast to all room members via PubSub (Beam.call to Elixir)
    Beam.call("room.broadcast", state.roomId, { from, text });
    return { state };
  }

  async handleInfo({ type: "member_left", userId }, state) {
    state.members.delete(userId);
    return { state };
  }

  async terminate(_reason, state) {
    const reg = Registry.lookup("rooms");
    reg.unregister(state.roomId);
  }
}

Application.start({
  id: "chat",
  supervisor: {
    strategy: "one_for_one",
    children: [
      { id: "rooms", start: () => Registry.start("rooms", { keys: "duplicate" }) },
      { id: "lobby", start: () => Room.startLink({ name: "lobby", args: { roomId: "lobby" } }) },
    ],
  },
});
```

Dynamically creating rooms:

```javascript
const sup = Supervisor.lookup("chat_sup");
await sup.startChild({
  id: `room:${roomId}`,
  start: () => Room.startLink({ name: `room:${roomId}`, args: { roomId } }),
  restart: "transient",
});
```

---

## 5. Multi-Node Distributed Workers

QuickBEAM supports `Beam.nodes()` and `Beam.rpc()`. beam-otp can dispatch work across BEAM cluster nodes:

```javascript
import { GenServer, Pool, Task } from "beam-otp";

class DistributedPool {
  constructor(pools) {
    this.pools = pools; // [{ node, pool }]
  }

  async dispatch(work) {
    // Find the least-loaded node
    const nodes = Beam.nodes();
    let best = this.pools[0];
    for (const p of this.pools) {
      if (nodes.includes(p.node)) {
        const status = await p.pool.status();
        if (status.idle > 0) { best = p; break; }
      }
    }

    return best.pool.transaction(async (worker) => {
      return await GenServer.call(worker, work);
    });
  }
}

// Or use RPC directly for one-off remote work
const ref = Task.async(async () => {
  return await Beam.rpc(remoteNode, "workers", "eval", { code: "...", input: {} });
});
const result = await Task.await(ref, 30_000);
```

---

## 6. Graceful Shutdown with Drain

Supervisor shutdown waits for workers to drain in-flight requests:

```javascript
class ApiWorker extends GenServer {
  async init() {
    return { inFlight: 0, draining: false };
  }

  async handleCall(msg, from, state) {
    if (state.draining) {
      return { reply: { error: "shutting_down" }, state };
    }
    const result = await processRequest(msg);
    return { reply: result, state: { ...state, inFlight: state.inFlight - 1 } };
  }

  async terminate(reason, state) {
    // Wait for in-flight requests to complete
    while (state.inFlight > 0) {
      await Beam.sleep(100);
    }
  }
}
```

The Supervisor's `shutdown` config controls how long to wait:

```javascript
{ id: "api", start: () => ApiWorker.startLink("api"), shutdown: 30_000 } // 30s drain
```
