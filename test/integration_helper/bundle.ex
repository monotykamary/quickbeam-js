defmodule QuickbeamJsE2E.Bundle do
  @moduledoc false

  def bundled_js do
    dist_dir = Path.join(File.cwd!(), "dist")

    files =
      Path.wildcard(Path.join(dist_dir, "*.js"))
      |> Enum.map(fn path ->
        filename = Path.basename(path)
        content = File.read!(path)
        {filename, content}
      end)

    # Entry point that assigns exports to globalThis.QuickbeamJs
    # (uses compiled JS to avoid OXC TypeScript template-literal bugs)
    entry_code = """
    import * as QuickbeamJs from "./index.js";
    globalThis.QuickbeamJs = QuickbeamJs;
    """

    QuickBEAM.JS.bundle!([{"e2e_entry.js", entry_code} | files],
      entry: "e2e_entry.js",
      drop_console: false
    )
  end
end
