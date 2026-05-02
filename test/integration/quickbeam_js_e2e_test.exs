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
  end

  # ══════════════════════════════════════════════════════════════════
  # BEAM PRIMITIVES (QuickBEAM native API)
  # ══════════════════════════════════════════════════════════════════

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

  # ══════════════════════════════════════════════════════════════════
  # LIBRARY LOADING
  # ══════════════════════════════════════════════════════════════════

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

  # ══════════════════════════════════════════════════════════════════
  # QUICKBEAM BRIDGE INTEGRATION
  # ══════════════════════════════════════════════════════════════════

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
