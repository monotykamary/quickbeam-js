# AGENTS.md

This file provides guidance to coding agents working with the quickbeam-js repository.

## Project Overview

quickbeam-js is a JavaScript-first orchestration layer for QuickBEAM. It provides OTP patterns — supervisors, workers, pools, registries, messaging — expressed as JavaScript APIs, so developers manage JS runtimes from JS instead of writing Elixir supervision trees.

The only Elixir required is a single bootstrap line. Everything else is JS.

## Documentation

**Read all docs before implementing.**

1. `docs/ARCHITECTURE.md` — Design decisions, mapping OTP→JS, comparison with Arc, tradeoffs
2. `docs/SPEC.md` — Full API specification with types, examples, and behavioral contracts
3. `docs/COOKBOOK.md` — Common patterns: SSR pool, LiveView context, rule engine, chat room

## QuickBEAM Dependency

quickbeam-js depends on [QuickBEAM](https://github.com/elixir-volt/quickbeam) (Hex: `quickbeam`). It does **not** embed or fork QuickBEAM. It is a pure JS library that uses QuickBEAM's existing `Beam.*` API as its foundation and adds higher-level orchestration abstractions on top.

Read the QuickBEAM README thoroughly before implementing — quickbeam-js wraps and extends these primitives:
- `Beam.spawn` → `Supervisor.startChild`
- `Beam.monitor` / `Beam.demonitor` → `Supervisor` crash recovery
- `Beam.link` / `Beam.unlink` → `Supervisor` crash propagation
- `Beam.send` / `Beam.onMessage` → `GenServer.call` / `cast`
- `Beam.call` / `Beam.callSync` → `GenServer.call` (with reply tracking)
- `Beam.whereis` / `Beam.register` → `Registry`

## Build and Test Commands

```bash
# Install dependencies
mix deps.get          # Elixir (QuickBEAM)
npm install           # JS (dev dependencies, types)

# Type check
npx tsc --noEmit

# Run tests
mix test              # Elixir-side (bootstrap, integration)
npm test              # JS-side (unit tests for supervisor, registry, etc.)

# Full CI
mix ci                # QuickBEAM's full quality gate (format, credo, dialyzer, test)
```

## Technology Stack

- **QuickBEAM** — JS runtime on the BEAM (Zig + QuickJS + lexbor)
- **TypeScript** — Implementation language, type-safe API
- **OXC** — Built-in TS→JS via QuickBEAM's `QuickBEAM.JS.transform`
- **Elixir** — Bootstrap only (`QuickBEAM.start/1`)
- **Vitest** or **Bun test** — JS unit tests (no BEAM needed for pure-logic tests)

## Code Style

- TypeScript strict mode
- All public APIs return `Promise` (the BEAM is async)
- Use `Beam.*` primitives directly — do not wrap them in additional C/NIF layers
- JSDoc on every exported function, class, and interface
- No decorators, no Reflect metadata — QuickBEAM contexts are plain objects
- Error handling: throw `BeamOtpError` with structured codes, never raw strings
- Tests: integration tests run against a live QuickBEAM runtime, unit tests mock `Beam.*`

## Architecture Constraints

1. **One Elixir line bootstrap** — The only Elixir is the supervisor child spec that starts the root QuickBEAM runtime with `quickbeam-js`'s entry script.
2. **No Elixir genserver modules** — quickbeam-js does not ship Elixir modules. All orchestration is JS.
3. **Crash recovery via Beam.monitor** — Supervisors detect child exits through monitors, not Elixir `:EXIT` messages.
4. **Stateless supervisor strategies** — Supervisor state (child specs, restart counts) lives in JS closures, not in ETS or Elixir processes.
5. **Registry backed by Beam.register** — Name registration delegates to QuickBEAM's existing `Beam.register`/`Beam.whereis`.
6. **Pool backed by Beam.spawn + monitors** — Pool workers are supervised children; checkout/checkin is JS-side bookkeeping.

## File Structure

```
src/
  index.ts              # Public API re-exports
  supervisor.ts         # Supervisor class, restart strategies, child specs
  gen-server.ts         # GenServer class: init/call/cast/handleInfo/terminate
  registry.ts           # Registry: register/unregister/lookup/whereis
  pool.ts               # Pool: fixed-size worker pool with checkout/checkin
  task.ts               # Task: fire-and-forget and await-supervised one-shots
  application.ts        # Application: boot supervisor tree from config
  errors.ts             # BeamOtpError hierarchy
  types.ts              # Shared types and interfaces
  utils.ts              # Helpers (sleep, retry, backoff)
test/
  integration/          # Tests requiring live QuickBEAM (mix test)
  unit/                 # Pure JS tests with mocked Beam.* (npm test)
docs/
  ARCHITECTURE.md
  SPEC.md
  COOKBOOK.md
```
