/**
 * GenServer — the generic server behaviour in JavaScript.
 *
 * In real QuickBEAM, each GenServer runs as a separate BEAM process
 * with its own QuickJS context. startLink() serializes the class
 * definition into a spawn script.
 *
 * In the mock/test environment, startLink() bypasses script generation
 * and uses direct closure spawning (spawnMockFn).
 *
 * @module gen-server
 */

import { Beam, BeamPid, BeamRef } from "./beam-shim.js";
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

// ── Detect environment ─────────────────────────────────────────────

function isMockEnvironment(): boolean {
  // In test: the first spawned pid has id=0 or we detect the mock marker
  return (globalThis as any).__quickbeam_mock !== undefined;
}

// ── Library bootstrap (for real QuickBEAM spawn scripts) ───────────

let _libraryBootstrap: string | null = null;

function getLibraryBootstrap(): string {
  if (_libraryBootstrap) return _libraryBootstrap;
  _libraryBootstrap = `
if (typeof QuickbeamJs === "undefined") {
  if (typeof require === "undefined") {
    throw new Error("QuickbeamJs not loaded. Ensure quickbeam-js is pre-loaded.");
  }
}
const { GenServer: _QbGenServer, runGenServerLoop } = QuickbeamJs;
`.trim();
  return _libraryBootstrap;
}

export function resetLibraryBootstrap(): void {
  _libraryBootstrap = null;
}

// ── Abstract GenServer ─────────────────────────────────────────────

export abstract class GenServer {
  async init(_args?: any): Promise<any> {
    return undefined;
  }

  async handleCall(_message: any, _from: From, _state: any): Promise<CallResult> {
    throw new Error(`handleCall not implemented. Received: ${JSON.stringify(_message)}`);
  }

  async handleCast(_message: any, state: any): Promise<CastResult> {
    return { state };
  }

  async handleInfo(_message: any, state: any): Promise<InfoResult> {
    return { state };
  }

  async terminate(_reason: any, _state: any): Promise<void> {
  }

  async codeChange(_oldVsn: any, state: any, _extra: any): Promise<any> {
    return state;
  }

  // ── Static API ───────────────────────────────────────────────────

  /**
   * Start a GenServer, link it to the caller, and optionally register it.
   *
   * @param cls - The GenServer subclass constructor.
   * @param config - Name, args, timeout.
   * @returns The PID of the started process.
   */
  static async startLink(
    cls: new () => GenServer,
    config?: GenServerConfig,
  ): Promise<BeamPid> {
    const { name, args } = config ?? {};

    if (name && Beam.whereis(name)) {
      throw BeamOtpError.alreadyStarted(name);
    }

    const instance = new cls();
    const initialState = await instance.init(args);

    if (isMockEnvironment()) {
      return spawnMockGenServer(instance, initialState, name);
    }

    return spawnRealGenServer(cls, instance, initialState, name, args);
  }

  /**
   * Make a synchronous call to a GenServer.
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
      let settled = false;
      let monRef: BeamRef | null = null;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        replyHandlers.delete(refKey(ref));
        if (monRef) Beam.demonitor(monRef);
        reject(BeamOtpError.timeout(`GenServer.call to '${target}'`, ms));
      }, ms);

      const replyHandlers = getReplyHandlers();

      replyHandlers.set(refKey(ref), (reply: GenReplyMessage) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        replyHandlers.delete(refKey(ref));
        if (monRef) Beam.demonitor(monRef);
        resolve(reply.result);
      });

      monRef = Beam.monitor(pid, (reason: any) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        replyHandlers.delete(refKey(ref));
        reject(BeamOtpError.exit(String(target), reason));
      });

      Beam.send(pid, callMsg);
    });
  }

  /**
   * Send an asynchronous cast to a GenServer.
   */
  static cast(target: string | BeamPid, message: any): void {
    const pid = resolveTarget(target);
    Beam.send(pid, { type: "cast", message });
  }
}

// ── Spawn helpers ──────────────────────────────────────────────────

async function spawnMockGenServer(
  instance: GenServer,
  initialState: any,
  name: string | undefined,
): Promise<BeamPid> {
  const pid = (Beam.spawn as any)(async () => {
    if (name) Beam.register(name);
    await runLoop(instance, initialState, name);
  }) as BeamPid;
  Beam.link(pid);
  return pid;
}

async function spawnRealGenServer(
  _cls: new () => GenServer,
  _instance: GenServer,
  _initialState: any,
  name: string | undefined,
  args: any,
): Promise<BeamPid> {
  const classSource = _cls.toString();
  const argsJson = JSON.stringify(args ?? null);
  const nameJson = JSON.stringify(name ?? null);
  const bootstrap = getLibraryBootstrap();

  const script = `
${bootstrap}

const _UserClass = (${classSource});
Object.setPrototypeOf(_UserClass.prototype, _QbGenServer.prototype);
Object.setPrototypeOf(_UserClass, _QbGenServer);

const _inst = new _UserClass();
const _args = ${argsJson};
const _name = ${nameJson};

_inst.init(_args).then(function(_state) {
  if (_name) Beam.register(_name);
  runGenServerLoop(_inst, _state);
}).catch(function(err) { throw err; });
`.trim();

  const pid = Beam.spawn(script);
  Beam.link(pid);
  return pid;
}

// ── Message Loop ───────────────────────────────────────────────────

async function runLoop(
  instance: GenServer,
  initialState: any,
  _name?: string,
): Promise<void> {
  let state = initialState;
  const selfPid = Beam.self();

  Beam.onMessage(async (msg: any) => {
    state = await dispatch(instance, msg, state, selfPid);
  });
}

/** Exported for spawn scripts to call from within the child process. */
export function runGenServerLoop(instance: GenServer, initialState: any): void {
  runLoop(instance, initialState);
}

async function dispatch(
  instance: GenServer,
  msg: any,
  state: any,
  selfPid: BeamPid,
): Promise<any> {
  void selfPid;
  switch (msg.type) {
    case "call": {
      const callMsg = msg as GenCallMessage;
      try {
        const from: From = { pid: callMsg.from, ref: callMsg.ref };
        const result = await instance.handleCall(callMsg.message, from, state);
        Beam.send(callMsg.from, {
          type: "reply",
          ref: callMsg.ref,
          result: result.reply,
        } satisfies GenReplyMessage);
        return result.state;
      } catch (err) {
        await safeTerminate(instance, err, state);
        throw err;
      }
    }

    case "cast": {
      try {
        const result = await instance.handleCast(msg.message, state);
        return result.state;
      } catch (err) {
        console.error(`[GenServer] handleCast error:`, err);
        return state;
      }
    }

    case "system": {
      const sysMsg = msg as GenSystemMessage;
      switch (sysMsg.action) {
        case "shutdown":
          await safeTerminate(instance, sysMsg.payload ?? "shutdown", state);
          throw new Error("shutdown");
        case "code_change":
          return await instance.codeChange(sysMsg.payload?.oldVsn, state, sysMsg.payload?.extra);
        default:
          return state;
      }
    }

    default: {
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

function resolveTarget(target: string | BeamPid): BeamPid {
  if (typeof target === "object" && target !== null && (target as any).__beam_type__ === "pid") {
    return target;
  }
  const pid = Beam.whereis(target as string);
  if (!pid) {
    throw BeamOtpError.noproc(target as string);
  }
  return pid;
}

function getReplyHandlers(): Map<string, (reply: any) => void> {
  const existing = (globalThis as any).__quickbeam_js_reply_handlers as Map<string, (reply: any) => void> | undefined;
  if (existing) return existing;
  const m = new Map<string, (reply: any) => void>();
  (globalThis as any).__quickbeam_js_reply_handlers = m;
  return m;
}

function refKey(ref: BeamRef): string {
  return "ref:" + ((ref as any).id ?? String(ref));
}
