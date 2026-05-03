defmodule QuickbeamJs do
  @moduledoc """
  Elixir helpers for quickbeam-js: bundling, loading, and booting.

  ## Usage

  Add `{:quickbeam_js, path: "deps/quickbeam_js"}` to your `mix.exs` deps,
  or copy this module into your project's `lib/` directory.

  ### Quick: load the pre-built bundle

  ```elixir
  # In your supervision tree:
  {QuickBEAM, name: :app, script: QuickbeamJs.prebuilt_bundle_path()}
  ```

  ### Full: bundle your own entry point (recommended)

  ```elixir
  # In your supervision tree:
  {QuickBEAM, name: :app, script: QuickbeamJs.bundle_app!("assets/js/app.ts")}
  ```
  """

  @doc """
  Returns the absolute path to the pre-built quickbeam-js bundle.

  The bundle sets `globalThis.QuickbeamJs` with all exports.
  Your own scripts can then reference `QuickbeamJs.GenServer`, etc.
  """
  @spec prebuilt_bundle_path() :: String.t()
  def prebuilt_bundle_path do
    [__DIR__, "..", "dist", "quickbeam-js.bundle.js"]
    |> Path.join()
    |> Path.expand()
  end

  @doc """
  Bundles a TypeScript entry point together with quickbeam-js using
  QuickBEAM's OXC bundler. Returns the bundled JS as a string.

  The entry point can use normal ES imports:

      import { GenServer, Supervisor } from "quickbeam-js";

  QuickBEAM's bundler resolves `"quickbeam-js"` through `node_modules`.
  """
  @spec bundle_app(String.t()) :: {:ok, String.t()} | {:error, term()}
  def bundle_app(entry_path) do
    QuickBEAM.JS.bundle_file(entry_path, drop_console: false)
  end

  @doc """
  Like `bundle_app/1`, but raises on error.

  Suitable for use as a module attribute:

      @app_js QuickbeamJs.bundle_app!("assets/js/app.ts")
  """
  @spec bundle_app!(String.t()) :: String.t()
  def bundle_app!(entry_path) do
    case bundle_app(entry_path) do
      {:ok, js} -> js
      {:error, reason} -> raise "Bundle failed for #{entry_path}: #{inspect(reason)}"
    end
  end

  @doc """
  Generates the pre-built quickbeam-js bundle and writes it to disk.

  This is called during CI / prepublish to produce `dist/quickbeam-js.bundle.js`.
  """
  @spec write_prebuilt_bundle!() :: :ok
  def write_prebuilt_bundle! do
    src_dir = Path.expand("src", File.cwd!())

    files =
      Path.wildcard(Path.join(src_dir, "*.ts"))
      |> Enum.map(fn path ->
        filename = Path.basename(path)
        content = File.read!(path)
        {filename, content}
      end)

    entry = """
    import * as QuickbeamJs from "./index.ts";
    globalThis.QuickbeamJs = QuickbeamJs;
    """

    bundled =
      QuickBEAM.JS.bundle!(
        [{"__entry.ts", entry} | files],
        entry: "__entry.ts",
        drop_console: false
      )

    out_path = Path.expand("dist/quickbeam-js.bundle.js", File.cwd!())
    File.mkdir_p!(Path.dirname(out_path))
    File.write!(out_path, bundled)

    IO.puts("Wrote pre-built bundle to #{out_path} (#{byte_size(bundled)} bytes)")
    :ok
  end
end
