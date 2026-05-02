defmodule QuickbeamJs.MixProject do
  use Mix.Project

  def project do
    [
      app: :quickbeam_js_e2e,
      version: "0.1.0",
      elixir: "~> 1.17",
      start_permanent: false,
      deps: deps(),
      elixirc_paths: ["test/integration_helper", "lib"],
      test_paths: ["test/integration"]
    ]
  end

  defp deps do
    [
      {:quickbeam, "~> 0.10.6"}
    ]
  end
end
