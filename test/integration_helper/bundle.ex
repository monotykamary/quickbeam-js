defmodule QuickbeamJsE2E.Bundle do
  @moduledoc false

  def bundled_js do
    src_dir = Path.join(File.cwd!(), "src")

    files =
      Path.wildcard(Path.join(src_dir, "*.ts"))
      |> Enum.map(fn path ->
        filename = Path.basename(path)
        content = File.read!(path)
        {filename, content}
      end)

    # Entry point that assigns exports to globalThis.QuickbeamJs
    entry_code =
      Path.join(File.cwd!(), "test/integration/e2e_entry.ts")
      |> File.read!()

    QuickBEAM.JS.bundle!([{"e2e_entry.ts", entry_code} | files],
      entry: "e2e_entry.ts",
      drop_console: false
    )
  end
end
