/**
 * Application — top-level entry point for beam-otp apps.
 *
 * `Application.start(config)` is the JS-side equivalent of Elixir's
 * `Application.start/2`. It starts the root supervisor tree and loads
 * environment config. Call this from your bootstrap script.
 *
 * @module application
 */

import { BeamOtpError } from "./errors.js";
import type { AppConfig } from "./types.js";
import type { Supervisor } from "./supervisor.js";
import { Supervisor as SupervisorAPI } from "./supervisor.js";

// ── Exported Application interface ─────────────────────────────────

export interface Application {
  /** Application identifier. */
  id: string;

  /** The root supervisor. */
  supervisor: Supervisor;

  /** Get an environment value. */
  getEnv(key: string): any;

  /** Set an environment value. */
  putEnv(key: string, value: any): void;

  /** Stop the application (shuts down the supervisor tree). */
  stop(): Promise<void>;
}

// ── Internal state ─────────────────────────────────────────────────

const runningApps = new Map<string, Application>();

// ── Namespaced Static API ──────────────────────────────────────────

export const Application = {
  /**
   * Start a beam-otp application.
   *
   * This is the top-level entry point. Called from your bootstrap JS
   * file (the one the Elixir side starts via QuickBEAM).
   *
   * @example
   * ```ts
   * import { Application } from "beam-otp";
   * Application.start({
   *   id: "my_app",
   *   env: { port: 4000 },
   *   supervisor: {
   *     strategy: "one_for_one",
   *     children: [
   *       { id: "db", start: () => Db.startLink() },
   *     ],
   *   },
   * });
   * ```
   */
  async start(config: AppConfig): Promise<Application> {
    const { id, supervisor: supConfig, env = {} } = config;

    if (runningApps.has(id)) {
      throw BeamOtpError.alreadyStarted(`Application '${id}'`);
    }

    const sup = await SupervisorAPI.start(supConfig);

    const app: Application = {
      id,
      supervisor: sup,
      getEnv(key: string): any {
        return env[key];
      },
      putEnv(key: string, value: any): void {
        env[key] = value;
      },
      async stop(): Promise<void> {
        await sup.shutdown();
        runningApps.delete(id);
      },
    };

    runningApps.set(id, app);
    return app;
  },

  /**
   * Stop a running application by ID.
   */
  async stop(id: string): Promise<void> {
    const app = runningApps.get(id);
    if (!app) throw BeamOtpError.notFound("application", id);
    await app.stop();
  },

  /**
   * List all running applications.
   */
  which(): Array<{ id: string }> {
    return Array.from(runningApps.entries()).map(([id]) => ({ id }));
  },
};
