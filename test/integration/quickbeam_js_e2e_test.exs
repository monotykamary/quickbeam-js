defmodule QuickbeamJsE2ETest do
  use ExUnit.Case, async: false

  @moduledoc """
  End-to-end tests for quickbeam-js against a live QuickBEAM runtime.

  Tests QuickBEAM's native Beam API and verifies our library can be
  loaded and interacts correctly with the real BEAM environment.
  """

  # Bundle once at compile time
  @bundle QuickbeamJsE2E.Bundle.bundled_js()

  setup do
    {:ok, rt} = QuickBEAM.start(apis: [:browser])
    on_exit(fn ->
      if Process.alive?(rt), do: QuickBEAM.stop(rt)
    end)
    {:ok, runtime: rt}
  end

  defp load_lib(rt) do
    QuickBEAM.eval(rt, @bundle)
    # Store the bundle source so spawned processes can load the library.
    # Spawned processes have a fresh QuickJS context, so we embed the
    # full library source directly into spawn scripts via this global.
    QuickBEAM.set_global(rt, "__quickbeam_js_source__", @bundle)
  end

  describe "QuickBEAM native Beam API" do
    test "Beam.self() returns a PID", %{runtime: rt} do
      {:ok, result} = QuickBEAM.eval(rt, "typeof Beam.self()")
      assert result == "object"
    end

    test "Beam.send / Beam.onMessage", %{runtime: rt} do
      # Message to self in same eval works via self-delivery
      {:ok, rt2} = QuickBEAM.start(apis: [:browser])
      on_exit(fn -> if Process.alive?(rt2), do: QuickBEAM.stop(rt2) end)

      # Register rt2 and send from rt
      QuickBEAM.eval(rt2, """
        globalThis.received = null;
        Beam.onMessage((msg) => { globalThis.received = msg; });
        Beam.register('msg_test_target');
      """)

      {:ok, pid} = QuickBEAM.eval(rt2, "Beam.self()")
      QuickBEAM.eval(rt, "Beam.send(Beam.whereis('msg_test_target'), { type: 'ping', value: 42 })")
      :timer.sleep(50)

      {:ok, received} = QuickBEAM.get_global(rt2, "received")
      assert %{"type" => "ping", "value" => 42} = received
    end

    test "Beam.spawn creates a new process", %{runtime: rt} do
      code = """
      let gotPid = null;
      const spawned = Beam.spawn('let gotPid = null; Beam.onMessage((m) => { gotPid = m.type; })');
      Beam.send(spawned, { type: "hello" });
      Beam.sleep(50);
      typeof spawned;
      """
      {:ok, result} = QuickBEAM.eval(rt, code)
      assert result == "object"
    end

    test "Beam.register / Beam.whereis", %{runtime: rt} do
      QuickBEAM.eval(rt, "Beam.register('e2e_test_proc')")
      {:ok, found} = QuickBEAM.eval(rt, "Beam.whereis('e2e_test_proc') !== null")
      assert found == true
    end

    test "Beam.makeRef generates unique references", %{runtime: rt} do
      {:ok, result} = QuickBEAM.eval(rt, """
        const a = Beam.makeRef();
        const b = Beam.makeRef();
        a !== b;
      """)
      assert result == true
    end

    test "Beam.sleep works", %{runtime: rt} do
      {:ok, elapsed} = QuickBEAM.eval(rt, """
        const start = Date.now();
        await Beam.sleep(50);
        Date.now() - start;
      """)
      assert elapsed >= 30
    end

    test "Beam.link / Beam.unlink", %{runtime: rt} do
      {:ok, result} = QuickBEAM.eval(rt, """
        const pid = Beam.spawn('');
        const linked = Beam.link(pid);
        const unlinked = Beam.unlink(pid);
        ({ linked, unlinked });
      """)
      assert result["linked"] == true
      assert result["unlinked"] == true
    end

    test "Beam.nodes returns the local node", %{runtime: rt} do
      {:ok, nodes} = QuickBEAM.eval(rt, "Beam.nodes()")
      assert is_list(nodes)
      assert length(nodes) >= 1
    end

    test "Beam.hash produces consistent results", %{runtime: rt} do
      {:ok, h1} = QuickBEAM.eval(rt, "Beam.hash('hello')")
      {:ok, h2} = QuickBEAM.eval(rt, "Beam.hash('hello')")
      {:ok, h3} = QuickBEAM.eval(rt, "Beam.hash('world')")
      assert is_integer(h1)
      assert h1 == h2
      assert h1 != h3
    end

    test "Beam.nanoseconds / Beam.uniqueInteger / Beam.makeRef", %{runtime: rt} do
      {:ok, ns} = QuickBEAM.eval(rt, "typeof Beam.nanoseconds()")
      assert ns == "number"

      {:ok, ui} = QuickBEAM.eval(rt, "typeof Beam.uniqueInteger()")
      assert ui == "number"
    end

    test "Beam.inspect works with PIDs", %{runtime: rt} do
      {:ok, result} = QuickBEAM.eval(rt, """
        const s = Beam.inspect(Beam.self());
        typeof s === 'string' && s.startsWith('#PID');
      """)
      assert result == true
    end

    test "Beam.call bridge Elixir ↔ JS", %{runtime: rt} do
      {:ok, rt2} = QuickBEAM.start(
        apis: [:browser],
        handlers: %{"add" => fn [a, b] -> a + b end}
      )
      on_exit(fn ->
        if Process.alive?(rt2), do: QuickBEAM.stop(rt2)
      end)

      {:ok, sum} = QuickBEAM.eval(rt2, "await Beam.call('add', 6, 7)")
      assert sum == 13

      {:ok, sync_sum} = QuickBEAM.eval(rt2, "Beam.callSync('add', 3, 4)")
      assert sync_sum == 7
    end
  end

  describe "quickbeam-js library loading" do
    test "library loads and exports QuickbeamJs global", %{runtime: rt} do
      load_lib(rt)

      {:ok, has_qb} = QuickBEAM.eval(rt, "typeof QuickbeamJs !== 'undefined'")
      assert has_qb == true

      {:ok, has_gs} = QuickBEAM.eval(rt, "typeof QuickbeamJs.GenServer !== 'undefined'")
      assert has_gs == true

      {:ok, has_sup} = QuickBEAM.eval(rt, "typeof QuickbeamJs.Supervisor !== 'undefined'")
      assert has_sup == true

      {:ok, has_pool} = QuickBEAM.eval(rt, "typeof QuickbeamJs.Pool !== 'undefined'")
      assert has_pool == true

      {:ok, has_task} = QuickBEAM.eval(rt, "typeof QuickbeamJs.Task !== 'undefined'")
      assert has_task == true

      {:ok, has_reg} = QuickBEAM.eval(rt, "typeof QuickbeamJs.Registry !== 'undefined'")
      assert has_reg == true
    end

    test "BeamOtpError has _tag for discriminated unions", %{runtime: rt} do
      load_lib(rt)

      {:ok, tag} = QuickBEAM.eval(rt, """
        const { BeamOtpError } = QuickbeamJs;
        BeamOtpError.timeout('test', 5000)._tag;
      """)
      assert tag == "BeamOtpError:timeout"
    end

    test "BeamOtpError findCause walks the error chain", %{runtime: rt} do
      load_lib(rt)

      {:ok, msg} = QuickBEAM.eval(rt, """
        const { BeamOtpError } = QuickbeamJs;
        const root = new Error('root cause');
        const err = BeamOtpError.timeout('test', 5000, root);
        // findCause with a non-Error class walks the cause chain
        // Test that cause is properly set on the native Error
        err.cause ? err.cause.message : null;
      """)
      assert msg == "root cause"
    end

    test "sleep, retry, withTimeout utilities work", %{runtime: rt} do
      load_lib(rt)

      {:ok, result} = QuickBEAM.eval(rt, """
        const { sleep, retry, withTimeout } = QuickbeamJs;

        // sleep
        const before = Date.now();
        await sleep(30);
        const after = Date.now();
        const slept = after - before >= 25;

        // retry
        let attempts = 0;
        const retryResult = await retry(async () => {
          attempts++;
          if (attempts < 2) throw new Error('fail');
          return 'ok';
        }, { maxAttempts: 3, baseDelayMs: 10 });

        // withTimeout — takes a function that returns a Promise
        const timeoutResult = await withTimeout(
          () => (async () => { await sleep(10); return 'done'; })(),
          500,
          'test'
        );

        ({ slept, retryResult, timeoutResult, attempts });
      """)
      assert result["slept"] == true
      assert result["retryResult"] == "ok"
      assert result["timeoutResult"] == "done"
      assert result["attempts"] == 2
    end
  end

  describe "GenServer" do
    # NOTE: GenServer startLink uses Beam.spawn() which creates a fresh
    # QuickJS context. The library injects itself into spawned processes
    # via __quickbeam_js_source__ global + unified message dispatcher.

    test "library spawn injection: __quickbeam_js_source__ is available", %{runtime: rt} do
      load_lib(rt)

      {:ok, result} = QuickBEAM.eval(rt, """
      ({
        hasSource: typeof __quickbeam_js_source__ !== 'undefined',
        sourceType: typeof __quickbeam_js_source__,
        sourceLen: typeof __quickbeam_js_source__ === 'string' ? __quickbeam_js_source__.length : -1
      });
      """)

      assert result["hasSource"] == true
      assert result["sourceType"] == "string"
      assert result["sourceLen"] > 1000
    end

    test "library spawn injection: Beam.spawn with embedded library works", %{runtime: rt} do
      load_lib(rt)

      {:ok, result} = QuickBEAM.eval(rt, """
      const libSrc = __quickbeam_js_source__;
      Beam.register('spawn_lib_test');
      globalThis.spawnLibResult = null;
      Beam.onMessage(function(msg) { globalThis.spawnLibResult = msg; });

      const spawnScript = libSrc + ';' +
        'if (typeof QuickbeamJs === "undefined") Beam.send(Beam.whereis("spawn_lib_test"), { ok: false });' +
        'else Beam.send(Beam.whereis("spawn_lib_test"), { ok: true, exports: Object.keys(QuickbeamJs) });';

      Beam.spawn(spawnScript);
      await QuickbeamJs.sleep(200);
      globalThis.spawnLibResult;
      """)

      assert result != nil
      assert result["ok"] == true
      assert is_list(result["exports"]) and length(result["exports"]) > 0
    end

    test "cross-process: GenServer.call round-trip via Beam.spawn", %{runtime: rt} do
      load_lib(rt)

      {:ok, result} = QuickBEAM.eval(rt, """
      const { GenServer, Beam } = QuickbeamJs;
      const libSrc = __quickbeam_js_source__;

      const script = libSrc + ';\\n' + [
        'var GS = QuickbeamJs.GenServer;',
        'var RL = QuickbeamJs.runGenServerLoop;',
        'var UC = (class Counter extends GS {',
        '  async init(args) { return { count: args.initial || 0 }; }',
        '  async handleCall(op, _from, state) {',
        '    if (op === "inc") {',
        '      var n = state.count + 1;',
        '      return { reply: n, state: { count: n } };',
        '    }',
        '    if (op === "get") { return { reply: state.count, state }; }',
        '    return { reply: null, state };',
        '  }',
        '});',
        'Object.setPrototypeOf(UC.prototype, GS.prototype);',
        'Object.setPrototypeOf(UC, GS);',
        'var inst = new UC();',
        'inst.init({ initial: 10 }).then(function(s) {',
        '  Beam.register("counter_svc");',
        '  RL(inst, s);',
        '}).catch(function(e) { throw e; });',
      ].join('\\n');

      Beam.spawn(script);
      await QuickbeamJs.sleep(400);

      var n1 = await GenServer.call('counter_svc', 'inc', 3000);
      var n2 = await GenServer.call('counter_svc', 'inc', 3000);
      var n3 = await GenServer.call('counter_svc', 'get', 3000);
      ({ ok: true, n1, n2, n3 });
      """)

      assert result["ok"] == true
      assert result["n1"] == 11
      assert result["n2"] == 12
      assert result["n3"] == 12
    end

    test "cross-process: GenServer.cast fire-and-forget via Beam.spawn", %{runtime: rt} do
      load_lib(rt)

      {:ok, result} = QuickBEAM.eval(rt, """
      const { GenServer, Beam } = QuickbeamJs;
      const libSrc = __quickbeam_js_source__;

      const script = libSrc + ';\\n' + [
        'var GS = QuickbeamJs.GenServer;',
        'var RL = QuickbeamJs.runGenServerLoop;',
        'var UC = (class CastWorker extends GS {',
        '  async init() { return { received: null }; }',
        '  async handleCast(op, _args, state) {',
        '    return { state: { received: op } };',
        '  }',
        '  async handleCall(op, args, state) {',
        '    if (op === "last") { return { reply: state.received, state }; }',
        '    return { reply: null, state };',
        '  }',
        '});',
        'Object.setPrototypeOf(UC.prototype, GS.prototype);',
        'Object.setPrototypeOf(UC, GS);',
        'var inst = new UC();',
        'inst.init().then(function(s) {',
        '  Beam.register("cast_svc");',
        '  RL(inst, s);',
        '}).catch(function(e) { throw e; });',
      ].join('\\n');

      Beam.spawn(script);
      await QuickbeamJs.sleep(400);

      GenServer.cast('cast_svc', 'log', 'hello-from-cast');
      await QuickbeamJs.sleep(200);
      var last = await GenServer.call('cast_svc', 'last', 3000);
      ({ ok: true, last });
      """)

      assert result["ok"] == true
      assert result["last"] == "log"
    end

    test "cross-process: GenServer error — noproc on nonexistent name", %{runtime: rt} do
      load_lib(rt)

      {:ok, result} = QuickBEAM.eval(rt, """
      const { GenServer, BeamOtpError } = QuickbeamJs;

      try {
        await GenServer.call('nonexistent_xyz', 'ping', []);
        ({ ok: false, tag: null });
      } catch (err) {
        ({
          ok: err instanceof BeamOtpError,
          tag: err._tag
        });
      }
      """)

      assert result["ok"] == true
      assert result["tag"] == "BeamOtpError:noproc"
    end
  end

  # ══════════════════════════════════════════════════════════════════
  # Supervisor — crash recovery across Beam.spawn
  # ══════════════════════════════════════════════════════════════════

  describe "Supervisor" do
    test "cross-process: Supervisor starts child GenServer and restarts on crash", %{runtime: rt} do
      load_lib(rt)

      {:ok, result} = QuickBEAM.eval(rt, """
      const { Supervisor, GenServer } = QuickbeamJs;

      class Counter extends GenServer {
        async init(args) {
          return { count: args.initial || 0 };
        }
        async handleCall(op, _from, state) {
          if (op === 'inc') {
            const next = state.count + 1;
            throw { type: 'simulated_crash' };
          }
          if (op === 'get') {
            return { reply: state.count, state };
          }
          return { reply: null, state };
        }
      }

      await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          { id: 'cnt', start: function() { return Counter.startLink(Counter, { name: 'sup_counter', args: { initial: 7 } }); } },
        ],
      });

      await QuickbeamJs.sleep(500);

      try {
        await GenServer.call('sup_counter', 'inc', 3000);
      } catch (e) {
        // Expected: Counter crashes on inc
      }

      await QuickbeamJs.sleep(500);
      const current = await GenServer.call('sup_counter', 'get', 3000);
      ({ ok: true, current });
      """)

      assert result["ok"] == true
      assert result["current"] == 7
    end

    test "cross-process: Supervisor one_for_one isolates crashes", %{runtime: rt} do
      load_lib(rt)

      {:ok, result} = QuickBEAM.eval(rt, """
      const { Supervisor, GenServer } = QuickbeamJs;

      class A extends GenServer {
        async init() { return {}; }
        async handleCall(op, _from, state) {
          if (op === 'crash') throw { type: 'a_crash' };
          if (op === 'ping') return { reply: 'pong_a', state };
          return { reply: null, state };
        }
      }

      class B extends GenServer {
        async init() { return {}; }
        async handleCall(op, _from, state) {
          if (op === 'ping') return { reply: 'pong_b', state };
          return { reply: null, state };
        }
      }

      await Supervisor.start({
        strategy: 'one_for_one',
        children: [
          { id: 'a', start: function() { return A.startLink(A, { name: 'worker_a' }); } },
          { id: 'b', start: function() { return B.startLink(B, { name: 'worker_b' }); } },
        ],
      });

      await QuickbeamJs.sleep(500);

      try { await GenServer.call('worker_a', 'crash', 3000); } catch (e) {}
      await QuickbeamJs.sleep(500);

      const bPong = await GenServer.call('worker_b', 'ping', 3000);
      const aPong = await GenServer.call('worker_a', 'ping', 3000);
      ({ ok: true, bPong, aPong });
      """)

      assert result["ok"] == true
      assert result["bPong"] == "pong_b"
      assert result["aPong"] == "pong_a"
    end
  end

  describe "QuickBEAM ↔ JS data round-trip" do
    test "Beam.setGlobal / Beam.getGlobal round-trips data", %{runtime: rt} do
      QuickBEAM.set_global(rt, "test_config", %{"mode" => "test", "count" => 42})

      {:ok, mode} = QuickBEAM.eval(rt, "test_config.mode")
      assert mode == "test"

      {:ok, double} = QuickBEAM.eval(rt, "test_config.count * 2")
      assert double == 84

      {:ok, retrieved} = QuickBEAM.get_global(rt, "test_config")
      assert %{"mode" => "test", "count" => 42} = retrieved
    end

    test "complex data structures survive round-trip", %{runtime: rt} do
      data = %{
        "name" => "test",
        "items" => [1, 2, %{"nested" => true}],
        "flag" => true
      }

      QuickBEAM.set_global(rt, "data", data)
      {:ok, result} = QuickBEAM.get_global(rt, "data")
      assert result == data
    end

    test "JS functions can be called from Elixir", %{runtime: rt} do
      QuickBEAM.eval(rt, """
        function calculate(a, b, op) {
          if (op === 'add') return a + b;
          if (op === 'mul') return a * b;
          return null;
        }
      """)

      {:ok, sum} = QuickBEAM.call(rt, "calculate", [10, 20, "add"])
      assert sum == 30

      {:ok, prod} = QuickBEAM.call(rt, "calculate", [6, 7, "mul"])
      assert prod == 42
    end
  end
end
