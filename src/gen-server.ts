/**
 * GenServer — the generic server behaviour in JavaScript.
 *
 * GenServer abstracts the message loop, call/cast/info dispatch,
 * name registration, and lifecycle (init/terminate/codeChange).
 * Subclass it and override the handler methods you need.
 *
 * @module gen-server
 */

import { Beam, BeamPid } from "./beam-shim.js";
import { BeamOtpError } from "./errors.js";
import type {
  From,
  CallResult,
  CastResult,
  InfoResult,
  GenServerConfig,
  GenCallMessage,
  GenReplyMessage,
  GenSystemMessage,
} from "./types.js";

// ── Abstract GenServer ─────────────────────────────────────────────

/**
 * Generic server base class. Subclass and override handler methods.
 *
 * @example
 * ```ts
 * class Counter extends GenServer {
 *   async init() { return { count: 0 }; }
 *   async handleCall(msg, _from, state) {
 *     if (msg === "inc") return { reply: ++state.count, state };
 *     if (msg === "get") return { reply: state.count, state };
 *     throw new Error(`unknown call: ${msg}`);
 *   }
 * }
 * ```
 */
export abstract class GenServer {
  /**
   * Called once at startup. Return the initial state.
   * Default: returns `undefined`.
   */
  async init(_args?: any): Promise<any> {
    return undefined;
  }

  /**
   * Handle a synchronous call. MUST return `{ reply, state }`.
   * Throw to crash the GenServer.
   */
  async handleCall(_message: any, _from: From, _state: any): Promise<CallResult> {
    throw new Error(`handleCall not implemented. Received: ${JSON.stringify(_message)}`);
  }

  /**
   * Handle an asynchronous cast. MUST return `{ state }`.
   * Throw to log-and-continue (default) or crash (if throwOnCastError).
   */
  async handleCast(_message: any, state: any): Promise<CastResult> {
    return { state };
  }

  /**
   * Handle an arbitrary message (info). MUST return `{ state }`.
   * Receives any message not tagged as "call", "cast", or "system".
   */
  async handleInfo(_message: any, state: any): Promise<InfoResult> {
    return { state };
  }

  /**
   * Called when the GenServer is shutting down (normal or crash).
   * The return value is ignored — this is for cleanup.
   */
  async terminate(_reason: any, _state: any): Promise<void> {
    // no-op by default
  }

  /**
   * Called after a hot code upgrade. Return the new state.
   */
  async codeChange(_oldVsn: any, state: any, _extra: any): Promise<any> {
    return state;
  }

  // ── Static API ───────────────────────────────────────────────────

  /**
   * Start a GenServer, link it to the caller, and optionally register it.
   *
   * @param cls - The GenServer subclass constructor.
   * @param config - Name, args, timeout, hibernate_after.
   * @returns The PID of the started process.
   */
  static async startLink(
    cls: new () => GenServer,
    config?: GenServerConfig,
  ): Promise<BeamPid> {
    const { name, args } = config ?? {};
    const instance = new cls();
    const initial = await instance.init(args);

    // Check if name is already taken
    if (name && Beam.whereis(name)) {
      throw BeamOtpError.alreadyStarted(name);
    }

    // Spawn a new process that runs the GenServer loop
    const pid = await Beam.spawn(async () => {
      const self = Beam.self();

      // Register under the given name
      if (name) {
        Beam.register(name, self);
      }

      // Enter the message loop
      await runLoop(instance, initial, config);
    });

    // Link the caller to the child (crash propagation)
    Beam.link(pid);

    return pid;
  }

  /**
   * Make a synchronous call to a GenServer.
   *
   * Sends a `{ type: "call", ref, from, message }` to the target and
   * blocks until a `{ type: "reply", ref, result }` arrives or timeout.
   *
   * @param target - Registered name or PID.
   * @param message - The message to send.
   * @param timeout - Milliseconds to wait (default: 5000).
   * @returns The reply value.
   * @throws BeamOtpError on timeout, exit, or noproc.
   */
  static async call(
    target: string | BeamPid,
    message: any,
    timeout?: number,
  ): Promise<any> {
    const ms = timeout ?? 5000;
    const pid = resolveTarget(target);
    const ref = Beam.makeRef();
    const from = Beam.self();

    const callMsg: GenCallMessage = {
      type: "call",
      ref,
      from,
      message,
    };

    return new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(BeamOtpError.timeout(`GenServer.call to '${target}'`, ms));
      }, ms);

      // Register a one-shot handler for the reply
      const prevHandler = (globalThis as any).__quickbeam_js_reply_handlers ?? new Map();
      (globalThis as any).__quickbeam_js_reply_handlers = prevHandler;

      prevHandler.set(ref, (reply: GenReplyMessage) => {
        clearTimeout(timer);
        prevHandler.delete(ref);
        resolve(reply.result);
      });

      // Also listen for exit of the target
      const exitHandler = (_pid: BeamPid, reason: any) => {
        clearTimeout(timer);
        prevHandler.delete(ref);
        reject(BeamOtpError.exit(String(target), reason));
      };
      const monRef = Beam.monitor(pid, exitHandler);

      // Cleanup on resolve/reject
      const cleanup = () => {
        Beam.demonitor(monRef);
      };

      const origResolve = resolve;
      const origReject = reject;
      resolve = ((val: any) => { cleanup(); origResolve(val); }) as any;
      reject = ((err: any) => { cleanup(); origReject(err); }) as any;

      // Send the call
      Beam.send(pid, callMsg);
    });
  }

  /**
   * Send an asynchronous cast to a GenServer.
   *
   * Sends `{ type: "cast", message }` — no reply, no confirmation.
   *
   * @param target - Registered name or PID.
   * @param message - The message to send.
   */
  static cast(target: string | BeamPid, message: any): void {
    const pid = resolveTarget(target);
    Beam.send(pid, { type: "cast", message });
  }
}

// ── Message Loop ───────────────────────────────────────────────────

interface LoopConfig {
  timeout?: number;
  hibernate_after?: number;
}

async function runLoop(
  instance: GenServer,
  initialState: any,
  _config?: LoopConfig,
): Promise<void> {
  let state = initialState;
  void _config;
  const selfPid = Beam.self();

  Beam.onMessage(async (msg: any) => {
    state = await dispatch(instance, msg, state, selfPid);
  });
}

async function dispatch(
  instance: GenServer,
  msg: any,
  state: any,
  selfPid: BeamPid,
): Promise<any> {
  switch (msg.type) {
    case "call": {
      const callMsg = msg as GenCallMessage;
      try {
        const from: From = { pid: callMsg.from, ref: callMsg.ref };
        const result = await instance.handleCall(callMsg.message, from, state);
        // Send reply to caller
        const replyMsg: GenReplyMessage = {
          type: "reply",
          ref: callMsg.ref,
          result: result.reply,
        };
        Beam.send(callMsg.from, replyMsg);
        return result.state;
      } catch (err) {
        // Handler threw — exit the GenServer with the error
        await safeTerminate(instance, err, state);
        Beam.exitProcess(selfPid, err);
        return state;
      }
    }

    case "cast": {
      try {
        const result = await instance.handleCast(msg.message, state);
        return result.state;
      } catch (err) {
        // Default: log and continue. Set throwOnCastError for crash behaviour.
        console.error(`[GenServer] handleCast error:`, err);
        return state;
      }
    }

    case "system": {
      const sysMsg = msg as GenSystemMessage;
      switch (sysMsg.action) {
        case "shutdown":
          await safeTerminate(instance, sysMsg.payload ?? "shutdown", state);
          Beam.exitProcess(selfPid, "shutdown");
          return state;
        case "code_change":
          return await instance.codeChange(sysMsg.payload?.oldVsn, state, sysMsg.payload?.extra);
        default:
          return state;
      }
    }

    default: {
      // Treat as info — anything not call/cast/system
      try {
        const result = await instance.handleInfo(msg, state);
        return result.state;
      } catch (err) {
        console.error(`[GenServer] handleInfo error:`, err);
        return state;
      }
    }
  }
}

async function safeTerminate(
  instance: GenServer,
  reason: any,
  state: any,
): Promise<void> {
  try {
    await instance.terminate(reason, state);
  } catch (err) {
    console.error(`[GenServer] terminate error:`, err);
  }
}

// ── Internal Helpers ───────────────────────────────────────────────

/**
 * Resolve a target (name or PID) to a concrete PID.
 * Throws `noproc` if the name is not registered.
 */
function resolveTarget(target: string | BeamPid): BeamPid {
  // QuickBEAM PIDs are typically strings like "<0.123.0>"
  if (typeof target === "string" && target.startsWith("<") && target.endsWith(">")) {
    return target;
  }
  const pid = Beam.whereis(target);
  if (!pid) {
    throw BeamOtpError.noproc(target);
  }
  return pid;
}
