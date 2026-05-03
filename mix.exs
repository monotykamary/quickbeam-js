defmodule QuickbeamJs.MixProject do
  use Mix.Project

  def project do
    [
      app: :quickbeam_js,
      version: "0.1.0",
      elixir: "~> 1.17",
      start_permanent: false,
      deps: deps(),
      elixirc_paths: elixirc_paths(Mix.env()),
      test_paths: ["test/integration"],

      # Package metadata
      description: "OTP patterns in JavaScript, on the BEAM — Elixir helpers and bundling",
      package: package(),
    ]
  end

  defp elixirc_paths(:test), do: ["lib", "test/integration_helper"]
  defp elixirc_paths(_), do: ["lib"]

  defp deps do
    [
      {:quickbeam, "~> 0.10.6"}
    ]
  end

  defp package do
    [
      licenses: ["MIT"],
      links: %{
        "GitHub" => "https://github.com/monotykamary/quickbeam-js",
        "npm" => "https://www.npmjs.com/package/quickbeam-js"
      }
    ]
  end
end
