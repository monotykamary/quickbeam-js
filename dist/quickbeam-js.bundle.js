(function() {

//#region rolldown:runtime
	var __defProp = Object.defineProperty;
	var __export = (all) => {
		let target = {};
		for (var name in all) __defProp(target, name, {
			get: all[name],
			enumerable: true
		});
		return target;
	};

//#endregion

//#region beam-shim.ts
	let _beam = null;
	function getBeam() {
		if (_beam) return _beam;
		if (typeof globalThis !== "undefined" && globalThis.Beam) {
			return globalThis.Beam;
		}
		throw new Error("Beam API not available. Are you running inside a QuickBEAM runtime? " + "For testing, call setMockBeam() first.");
	}
	function setMockBeam(mock) {
		_beam = mock;
	}
	const Beam = new Proxy({}, { get(_target, prop) {
		const b = getBeam();
		const val = b[prop];
		if (typeof val === "function") return val.bind(b);
		return val;
	} });

//#endregion
//#region errors.ts
/**
	* Structured error thrown by all quickbeam-js operations.
	*
	* Follows the errore pattern:
	* - **`_tag`** — string literal for type narrowing (primary discriminant)
	* - **`cause`** — chained original error (Go `%w` equivalent)
	* - **`findCause()`** — walk the cause chain (Go `errors.As` equivalent)
	* - **`code`** — deprecated alias for `_tag`, kept for backward compatibility
	* - **`reason`** — deprecated alias for `cause`, kept for backward compatibility
	*
	* @example
	* ```ts
	* const result: User | BeamOtpError = await getUser(id);
	* if (result instanceof BeamOtpError) {
	*   // Narrow by _tag
	*   if (result._tag === "BeamOtpError:not_found") {
	*     console.log("Not found:", result.message);
	*   }
	*   // Walk nested causes
	*   const dbErr = result.findCause(DbError);
	*   if (dbErr) console.log("Root cause:", dbErr.message);
	*   return;
	* }
	* console.log(result.name); // result is User
	* ```
	*/
	var BeamOtpError = class BeamOtpError extends Error {
		/** Tag for type-level error discrimination. */
		_tag;
		/**
		* Optional additional detail (exit reason, stack, etc.).
		*
		* @deprecated Prefer chaining the original error via `cause` (native Error property)
		*              and use `findCause()` to walk the chain.
		*/
		reason;
		/**
		* Create a new quickbeam-js error.
		*
		* @param tag - Discriminant tag for narrowing.
		* @param message - Human-readable message.
		* @param options - Optional chaining and detail.
		* @param options.cause - Chain a causing error (Go `%w` equivalent).
		*                        Sets the native `Error.cause` property.
		* @param options.reason - Legacy detail. Consider using `cause` instead.
		*/
		constructor(tag, message, options) {
			super(message, options?.cause ? { cause: options.cause } : undefined);
			this.name = "BeamOtpError";
			this._tag = tag;
			this.reason = options?.reason;
		}
		/**
		* Machine-readable error code.
		*
		* @deprecated Use `_tag` instead. This accessor extracts the suffix
		*             from `_tag` (e.g. `"timeout"` from `"BeamOtpError:timeout"`).
		*             Kept for backward compatibility with existing `err.code` checks.
		*/
		get code() {
			return this._tag.replace("BeamOtpError:", "");
		}
		/**
		* Walk the cause chain to find an ancestor matching a specific error class.
		*
		* Equivalent to Go's `errors.As`. Checks `this` first, then traverses
		* `this.cause` recursively. TypeScript infers the return type from the
		* constructor argument.
		*
		* @param errorClass - Constructor of the error type to find.
		* @returns The matched error with full type inference, or `undefined`.
		*
		* @example
		* ```ts
		* const dbErr = svcErr.findCause(DbError);
		* dbErr?.host; // type-safe access
		* ```
		*/
		findCause(errorClass) {
			if (this instanceof errorClass) {
				return this;
			}
			let current = this.cause;
			const visited = new Set();
			while (current && !visited.has(current)) {
				visited.add(current);
				if (current instanceof errorClass) {
					return current;
				}
				current = current.cause;
			}
			return undefined;
		}
		/** Create a timeout error. */
		static timeout(operation, ms, cause) {
			return new BeamOtpError("BeamOtpError:timeout", `${operation} timed out after ${ms}ms`, { cause });
		}
		/** Create an exit error (target process exited). */
		static exit(target, reason, cause) {
			return new BeamOtpError("BeamOtpError:exit", `Process ${target} exited`, {
				cause,
				reason
			});
		}
		/** Create a noproc error (no process registered). */
		static noproc(name, cause) {
			return new BeamOtpError("BeamOtpError:noproc", `No process registered under '${name}'`, { cause });
		}
		/** Create an already-started error. */
		static alreadyStarted(name, cause) {
			return new BeamOtpError("BeamOtpError:already_started", `Name '${name}' is already registered`, { cause });
		}
		/** Create a not-found error. */
		static notFound(what, id, cause) {
			return new BeamOtpError("BeamOtpError:not_found", `${what} '${id}' not found`, { cause });
		}
		/** Create a shutdown error. */
		static shutdown(reason, cause) {
			return new BeamOtpError("BeamOtpError:shutdown", "Supervisor is shutting down", {
				cause,
				reason
			});
		}
		/** Create a restart-limit error. */
		static restartLimit(maxR, maxS, cause) {
			return new BeamOtpError("BeamOtpError:restart_limit", `Reached max restart intensity (${maxR} restarts in ${maxS}s)`, { cause });
		}
	};
	/**
	* Standalone `findCause` that works on any Error.
	*
	* Equivalent to Go's `errors.As`. Checks the error itself first, then
	* traverses `.cause` recursively. Safe against circular references.
	*
	* @param err - The error to search.
	* @param errorClass - Constructor of the error type to find.
	* @returns The matched error with full type inference, or `undefined`.
	*
	* @example
	* ```ts
	* import { findCause } from "quickbeam-js";
	* const dbErr = findCause(wrapped, DbError);
	* ```
	*/
	function findCause(err, errorClass) {
		if (err instanceof errorClass) {
			return err;
		}
		let current = err.cause;
		const visited = new Set();
		while (current && !visited.has(current)) {
			visited.add(current);
			if (current instanceof errorClass) {
				return current;
			}
			current = current.cause;
		}
		return undefined;
	}

//#endregion
//#region gen-server.ts
	function isMockEnvironment() {
		return globalThis.__quickbeam_mock !== undefined;
	}
	let _libraryBootstrap = null;
	function getLibraryBootstrap() {
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
	function resetLibraryBootstrap() {
		_libraryBootstrap = null;
	}
	var GenServer = class {
		async init(_args) {
			return undefined;
		}
		async handleCall(_message, _from, _state) {
			throw new Error(`handleCall not implemented. Received: ${JSON.stringify(_message)}`);
		}
		async handleCast(_message, state) {
			return { state };
		}
		async handleInfo(_message, state) {
			return { state };
		}
		async terminate(_reason, _state) {}
		async codeChange(_oldVsn, state, _extra) {
			return state;
		}
		/**
		* Start a GenServer, link it to the caller, and optionally register it.
		*
		* @param cls - The GenServer subclass constructor.
		* @param config - Name, args, timeout.
		* @returns The PID of the started process.
		*/
		static async startLink(cls, config) {
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
		static async call(target, message, timeout) {
			const ms = timeout ?? 5e3;
			const pid = resolveTarget(target);
			const ref = Beam.makeRef();
			const from = Beam.self();
			const callMsg = {
				type: "call",
				ref,
				from,
				message
			};
			return new Promise((resolve, reject) => {
				let settled = false;
				let monRef = null;
				const timer = setTimeout(() => {
					if (settled) return;
					settled = true;
					replyHandlers.delete(refKey(ref));
					if (monRef) Beam.demonitor(monRef);
					reject(BeamOtpError.timeout(`GenServer.call to '${target}'`, ms));
				}, ms);
				const replyHandlers = getReplyHandlers();
				replyHandlers.set(refKey(ref), (reply) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					replyHandlers.delete(refKey(ref));
					if (monRef) Beam.demonitor(monRef);
					resolve(reply.result);
				});
				monRef = Beam.monitor(pid, (reason) => {
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
		static cast(target, message) {
			const pid = resolveTarget(target);
			Beam.send(pid, {
				type: "cast",
				message
			});
		}
	};
	async function spawnMockGenServer(instance, initialState, name) {
		const pid = Beam.spawn(async () => {
			if (name) Beam.register(name);
			await runLoop(instance, initialState, name);
		});
		Beam.link(pid);
		return pid;
	}
	async function spawnRealGenServer(_cls, _instance, _initialState, name, args) {
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
	async function runLoop(instance, initialState, _name) {
		let state = initialState;
		const selfPid = Beam.self();
		Beam.onMessage(async (msg) => {
			state = await dispatch(instance, msg, state, selfPid);
		});
	}
	/** Exported for spawn scripts to call from within the child process. */
	function runGenServerLoop(instance, initialState) {
		runLoop(instance, initialState);
	}
	async function dispatch(instance, msg, state, selfPid) {
		void selfPid;
		switch (msg.type) {
			case "call": {
				const callMsg = msg;
				try {
					const from = {
						pid: callMsg.from,
						ref: callMsg.ref
					};
					const result = await instance.handleCall(callMsg.message, from, state);
					Beam.send(callMsg.from, {
						type: "reply",
						ref: callMsg.ref,
						result: result.reply
					});
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
				const sysMsg = msg;
				switch (sysMsg.action) {
					case "shutdown":
						await safeTerminate(instance, sysMsg.payload ?? "shutdown", state);
						throw new Error("shutdown");
					case "code_change": return await instance.codeChange(sysMsg.payload?.oldVsn, state, sysMsg.payload?.extra);
					default: return state;
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
	async function safeTerminate(instance, reason, state) {
		try {
			await instance.terminate(reason, state);
		} catch (err) {
			console.error(`[GenServer] terminate error:`, err);
		}
	}
	function resolveTarget(target) {
		if (typeof target === "object" && target !== null && target.__beam_type__ === "pid") {
			return target;
		}
		const pid = Beam.whereis(target);
		if (!pid) {
			throw BeamOtpError.noproc(target);
		}
		return pid;
	}
	function getReplyHandlers() {
		const existing = globalThis.__quickbeam_js_reply_handlers;
		if (existing) return existing;
		const m = new Map();
		globalThis.__quickbeam_js_reply_handlers = m;
		return m;
	}
	function refKey(ref) {
		return "ref:" + (ref.id ?? String(ref));
	}

//#endregion
//#region utils.ts
/**
	* Non-blocking sleep (yields to the BEAM scheduler).
	*
	* @param ms - Milliseconds to wait.
	*/
	async function sleep(ms) {
		return Beam.sleep(ms);
	}
	/**
	* Retry an async operation with exponential backoff.
	*
	* @param fn - The operation to retry.
	* @param options - Retry configuration.
	* @returns The result of `fn` on success.
	* @throws The last error if all attempts fail.
	*/
	async function retry(fn, options = {}) {
		const { maxAttempts = 3, baseDelayMs = 100, maxDelayMs = 5e3, backoffFactor = 2, onRetry } = options;
		let lastError;
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				return await fn();
			} catch (err) {
				lastError = err;
				if (attempt < maxAttempts) {
					onRetry?.(attempt, err);
					const delay = Math.min(baseDelayMs * Math.pow(backoffFactor, attempt - 1), maxDelayMs);
					await sleep(delay);
				}
			}
		}
		throw lastError;
	}
	/**
	* Execute an async operation with a timeout. Throws if `fn` doesn't
	* settle within `timeoutMs` milliseconds.
	*
	* @param fn - The operation to run.
	* @param timeoutMs - Deadline in milliseconds.
	* @param label - Human-readable label for the error message.
	* @returns The result of `fn`.
	*/
	async function withTimeout(fn, timeoutMs, label = "operation") {
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new BeamOtpError("BeamOtpError:timeout", `${label} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			fn().then((result) => {
				clearTimeout(timer);
				resolve(result);
			}).catch((err) => {
				clearTimeout(timer);
				reject(err);
			});
		});
	}
	/**
	* Generate a unique string ID.
	*/
	function makeId(prefix = "id") {
		return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
	}
	/**
	* Return a promise that resolves after `ms` with the given value.
	*/
	function delayed(ms, value) {
		return new Promise((resolve) => setTimeout(() => resolve(value), ms));
	}
	/**
	* Sequential async map — runs `fn` on each item in series.
	*/
	async function asyncMapSeries(items, fn) {
		const results = [];
		for (let i = 0; i < items.length; i++) {
			results.push(await fn(items[i], i));
		}
		return results;
	}
	/**
	* Reverse sequential async map — runs `fn` on each item in reverse series.
	*/
	async function asyncMapSeriesReverse(items, fn) {
		const results = new Array(items.length);
		for (let i = items.length - 1; i >= 0; i--) {
			results[i] = await fn(items[i], i);
		}
		return results;
	}

//#endregion
//#region supervisor.ts
	const Supervisor = {
		async start(config) {
			return createSupervisor(config);
		},
		async startChild(sup, spec) {
			const internal = sup;
			if (internal._shuttingDown()) throw BeamOtpError.shutdown();
			return internal._addChild(spec);
		},
		async terminateChild(sup, id) {
			const internal = sup;
			await internal._terminateChild(id);
		},
		async restartChild(sup, id) {
			const internal = sup;
			return internal._restartChild(id);
		}
	};
	async function createSupervisor(config) {
		const { strategy = "one_for_one", children: childSpecs, max_restarts = 3, max_seconds = 5 } = config;
		const children = new Map();
		const startOrder = [];
		let shuttingDown = false;
		let inRestart = false;
		const restartTimestamps = [];
		const pid = Beam.self();
		function trackRestart() {
			const now = Date.now();
			const windowStart = now - max_seconds * 1e3;
			while (restartTimestamps.length > 0 && restartTimestamps[0] < windowStart) {
				restartTimestamps.shift();
			}
			restartTimestamps.push(now);
			if (restartTimestamps.length > max_restarts) {
				const err = BeamOtpError.restartLimit(max_restarts, max_seconds);
				shutdownAll().then(() => {
					throw err;
				});
				throw err;
			}
		}
		async function shutdownAll() {
			shuttingDown = true;
			const reversed = [...startOrder].reverse();
			for (const id of reversed) {
				await terminateChildInternal(id);
			}
		}
		async function terminateChildInternal(id) {
			const child = children.get(id);
			if (!child || child.pid === null) return;
			const shutdownMs = child.spec.shutdown ?? 5e3;
			const childPid = child.pid;
			let monRef = null;
			const exitPromise = new Promise((resolve) => {
				monRef = Beam.monitor(childPid, () => {
					resolve();
				});
			});
			Beam.send(childPid, {
				type: "system",
				action: "shutdown",
				payload: "shutdown"
			});
			if (shutdownMs === "infinity") {
				await exitPromise;
			} else {
				const result = await Promise.race([exitPromise.then(() => "exit"), sleep(shutdownMs).then(() => "timeout")]);
				if (result === "timeout") {
					Beam.send(childPid, {
						type: "system",
						action: "shutdown",
						payload: "kill"
					});
					await exitPromise;
				}
			}
			if (monRef) Beam.demonitor(monRef);
			if (child.monitorRef) Beam.demonitor(child.monitorRef);
			child.pid = null;
			child.monitorRef = null;
		}
		function handleChildExit(id, reason) {
			if (shuttingDown || inRestart) return;
			const child = children.get(id);
			if (!child) return;
			child.pid = null;
			child.monitorRef = null;
			const restart = child.spec.restart ?? "permanent";
			let shouldRestart = false;
			switch (restart) {
				case "permanent":
					shouldRestart = true;
					break;
				case "temporary":
					shouldRestart = false;
					break;
				case "transient":
					shouldRestart = reason !== "normal" && reason !== "shutdown";
					break;
			}
			if (!shouldRestart) return;
			trackRestart();
			switch (strategy) {
				case "one_for_one":
					restartChildInternal(id).catch((err) => {
						console.error(`[Supervisor] failed to restart child '${id}':`, err);
					});
					break;
				case "one_for_all":
					restartAllChildren().catch((err) => {
						console.error("[Supervisor] failed to restart all children:", err);
					});
					break;
				case "rest_for_one":
					restartFromChild(id).catch((err) => {
						console.error(`[Supervisor] failed to restart from child '${id}':`, err);
					});
					break;
			}
		}
		async function restartChildInternal(id) {
			const child = children.get(id);
			if (!child) throw BeamOtpError.notFound("child", id);
			if (child.pid !== null) {
				await terminateChildInternal(id);
			}
			child.restarts++;
			const newPid = await child.spec.start();
			child.pid = newPid;
			child.startTime = Date.now();
			const monRef = Beam.monitor(newPid, (reason) => {
				handleChildExit(id, reason);
			});
			child.monitorRef = monRef;
			return newPid;
		}
		async function restartAllChildren() {
			inRestart = true;
			try {
				const reversed = [...startOrder].reverse();
				for (const id of reversed) {
					const child = children.get(id);
					if (child && child.pid !== null) {
						await terminateChildInternal(id);
					}
				}
				for (const id of startOrder) {
					await restartChildInternal(id);
				}
			} finally {
				inRestart = false;
			}
		}
		async function restartFromChild(crashedId) {
			inRestart = true;
			try {
				const idx = startOrder.indexOf(crashedId);
				if (idx === -1) return;
				for (let i = startOrder.length - 1; i >= idx; i--) {
					const id = startOrder[i];
					const child = children.get(id);
					if (child && child.pid !== null) {
						await terminateChildInternal(id);
					}
				}
				for (let i = idx; i < startOrder.length; i++) {
					await restartChildInternal(startOrder[i]);
				}
			} finally {
				inRestart = false;
			}
		}
		async function startChildInternal(spec) {
			const childPid = await spec.start();
			const monRef = Beam.monitor(childPid, (reason) => {
				handleChildExit(spec.id, reason);
			});
			const childState = {
				spec,
				pid: childPid,
				monitorRef: monRef,
				restarts: 0,
				startTime: Date.now()
			};
			children.set(spec.id, childState);
			return childPid;
		}
		const sup = {
			pid,
			whichChildren() {
				const result = [];
				for (const [id, child] of children) {
					if (child.pid !== null) {
						result.push({
							id,
							pid: child.pid,
							type: child.spec.type ?? "worker",
							restart: child.spec.restart ?? "permanent"
						});
					}
				}
				return result;
			},
			count() {
				let specs = 0, active = 0, supervisors = 0, workers = 0;
				for (const [, child] of children) {
					specs++;
					if (child.pid !== null) {
						active++;
						if ((child.spec.type ?? "worker") === "supervisor") supervisors++;
						else workers++;
					}
				}
				return {
					specs,
					active,
					supervisors,
					workers
				};
			},
			async shutdown() {
				await shutdownAll();
			},
			async _addChild(spec) {
				if (shuttingDown) throw BeamOtpError.shutdown();
				if (children.has(spec.id)) {
					throw new BeamOtpError("BeamOtpError:already_started", `Child '${spec.id}' already exists`);
				}
				const childPid = await startChildInternal(spec);
				startOrder.push(spec.id);
				return childPid;
			},
			async _terminateChild(id) {
				if (!children.has(id)) throw BeamOtpError.notFound("child", id);
				const child = children.get(id);
				if (child.monitorRef) {
					Beam.demonitor(child.monitorRef);
					child.monitorRef = null;
				}
				await terminateChildInternal(id);
				children.delete(id);
				const idx = startOrder.indexOf(id);
				if (idx !== -1) startOrder.splice(idx, 1);
			},
			async _restartChild(id) {
				if (!children.has(id)) throw BeamOtpError.notFound("child", id);
				if (!startOrder.includes(id)) startOrder.push(id);
				return restartChildInternal(id);
			},
			_shuttingDown() {
				return shuttingDown;
			}
		};
		const started = [];
		try {
			for (const spec of childSpecs) {
				await startChildInternal(spec);
				started.push(spec.id);
				startOrder.push(spec.id);
			}
		} catch (err) {
			for (const id of [...started].reverse()) {
				try {
					await terminateChildInternal(id);
				} catch (_) {}
			}
			for (const id of started) {
				children.delete(id);
				const idx2 = startOrder.indexOf(id);
				if (idx2 !== -1) startOrder.splice(idx2, 1);
			}
			throw err;
		}
		return sup;
	}

//#endregion
//#region registry.ts
	const activeRegistries = new Map();
	const Registry = {
		async start(name, config) {
			const keysMode = config?.keys ?? "unique";
			const entries = new Map();
			if (activeRegistries.has(name)) {
				throw BeamOtpError.alreadyStarted(`Registry '${name}'`);
			}
			activeRegistries.set(name, {
				keysMode,
				entries
			});
			Beam.register(name);
			return makeRegistry(name, {
				keysMode,
				entries
			});
		},
		lookup(name) {
			const state = activeRegistries.get(name);
			if (!state) {
				throw BeamOtpError.noproc(`Registry '${name}'`);
			}
			return makeRegistry(name, state);
		}
	};
	function makeRegistry(name, state) {
		const { keysMode, entries } = state;
		return {
			name,
			register(key, value) {
				const pid = Beam.self();
				const monRef = Beam.monitor(pid, () => {
					unregisterEntry(entries, key, pid, keysMode);
				});
				const entry = {
					pid,
					value,
					monitorRef: monRef
				};
				if (keysMode === "unique") {
					if (entries.has(key)) {
						Beam.demonitor(monRef);
						throw new BeamOtpError("BeamOtpError:already_started", `Key '${key}' is already registered`);
					}
					entries.set(key, entry);
				} else {
					const existing = entries.get(key);
					if (existing) {
						existing.push(entry);
					} else {
						entries.set(key, [entry]);
					}
				}
			},
			unregister(key) {
				unregisterEntry(entries, key, Beam.self(), keysMode);
			},
			lookup(key) {
				const entry = entries.get(key);
				if (!entry) return undefined;
				if (keysMode === "unique") {
					const e = entry;
					return [[e.pid, e.value]];
				}
				return entry.map((e) => [e.pid, e.value]);
			},
			match(predicate) {
				const result = new Map();
				for (const [key, entry] of entries) {
					if (keysMode === "unique") {
						const e = entry;
						if (predicate(key, e.value)) {
							result.set(key, [[e.pid, e.value]]);
						}
					} else {
						const list = entry;
						const matched = list.filter((e) => predicate(key, e.value));
						if (matched.length > 0) {
							result.set(key, matched.map((e) => [e.pid, e.value]));
						}
					}
				}
				return result;
			},
			count() {
				let total = 0;
				for (const entry of entries.values()) {
					total += Array.isArray(entry) ? entry.length : 1;
				}
				return total;
			}
		};
	}
	function unregisterEntry(entriesMap, key, pid, keysMode) {
		if (keysMode === "unique") {
			const existing = entriesMap.get(key);
			if (existing && pidsEqual$1(existing.pid, pid)) {
				Beam.demonitor(existing.monitorRef);
				entriesMap.delete(key);
			}
		} else {
			const existing = entriesMap.get(key);
			if (existing) {
				const idx = existing.findIndex((e) => pidsEqual$1(e.pid, pid));
				if (idx !== -1) {
					Beam.demonitor(existing[idx].monitorRef);
					existing.splice(idx, 1);
					if (existing.length === 0) entriesMap.delete(key);
				}
			}
		}
	}
	function pidsEqual$1(a, b) {
		return a.__beam_type__ === "pid" && b.__beam_type__ === "pid" && (a.id === b.id || a.__beam_data__ === b.__beam_data__);
	}

//#endregion
//#region pool.ts
	const Pool = { async start(config) {
		const { name, size, child: ChildClass, childArgs, strategy = "fifo", overflow: _overflow = 0, max_overflow: _maxOverflow = 0 } = config;
		const workers = new Map();
		const idleQueue = [];
		let waitingCheckouts = [];
		let shuttingDown = false;
		const childSpecs = [];
		for (let i = 0; i < size; i++) {
			childSpecs.push({
				id: `worker_${i}`,
				start: async () => {
					return ChildClass.startLink(ChildClass, {
						name: `${name}_${i}`,
						args: childArgs
					});
				},
				restart: "permanent",
				shutdown: 5e3,
				type: "worker"
			});
		}
		const sup = await Supervisor.start({
			strategy: "one_for_one",
			children: childSpecs,
			max_restarts: size * 2,
			max_seconds: 5
		});
		let idx = 0;
		for (const childInfo of sup.whichChildren()) {
			const workerId = childInfo.id;
			const monRef = Beam.monitor(childInfo.pid, (_reason) => {
				handleWorkerExit(workerId, _reason);
			});
			workers.set(workerId, {
				pid: childInfo.pid,
				inUse: false,
				monitorRef: monRef
			});
			idleQueue.push(workerId);
			idx++;
		}
		function handleWorkerExit(workerId, _reason) {
			const worker = workers.get(workerId);
			if (!worker) return;
			const qIdx = idleQueue.indexOf(workerId);
			if (qIdx !== -1) idleQueue.splice(qIdx, 1);
			worker.inUse = false;
		}
		function processQueue() {
			while (waitingCheckouts.length > 0 && idleQueue.length > 0) {
				const waiter = waitingCheckouts.shift();
				const workerId = strategy === "lifo" ? idleQueue.pop() : idleQueue.shift();
				const worker = workers.get(workerId);
				worker.inUse = true;
				clearTimeout(waiter.timer);
				waiter.resolve(worker.pid);
			}
		}
		const pool = {
			pid: sup.pid,
			checkout(timeout = 5e3) {
				if (shuttingDown) return Promise.reject(BeamOtpError.shutdown());
				if (idleQueue.length > 0) {
					const workerId = strategy === "lifo" ? idleQueue.pop() : idleQueue.shift();
					const worker = workers.get(workerId);
					worker.inUse = true;
					return Promise.resolve(worker.pid);
				}
				return new Promise((resolve, reject) => {
					const timer = setTimeout(() => {
						const wIdx = waitingCheckouts.findIndex((w) => w.resolve === resolve && w.reject === reject);
						if (wIdx !== -1) waitingCheckouts.splice(wIdx, 1);
						reject(BeamOtpError.timeout("Pool.checkout", timeout));
					}, timeout);
					waitingCheckouts.push({
						resolve,
						reject,
						timer
					});
				});
			},
			checkin(pid) {
				for (const [workerId, worker] of workers) {
					if (pidsEqual(worker.pid, pid) && worker.inUse) {
						worker.inUse = false;
						idleQueue.push(workerId);
						processQueue();
						return;
					}
				}
				console.warn(`[Pool] checkin: worker not found or already idle`);
			},
			status() {
				let active = 0, idle = 0;
				for (const worker of workers.values()) {
					if (worker.inUse) active++;
					else idle++;
				}
				return {
					size,
					active,
					idle,
					overflow: 0
				};
			},
			async transaction(fn, timeout) {
				const worker = await pool.checkout(timeout);
				try {
					return await fn(worker);
				} finally {
					pool.checkin(worker);
				}
			},
			async shutdown() {
				shuttingDown = true;
				for (const waiter of waitingCheckouts) {
					clearTimeout(waiter.timer);
					waiter.reject(BeamOtpError.shutdown());
				}
				waitingCheckouts = [];
				await sup.shutdown();
			}
		};
		return pool;
	} };
	function pidsEqual(a, b) {
		return a.__beam_type__ === "pid" && b.__beam_type__ === "pid" && (a.id === b.id || a.__beam_data__ === b.__beam_data__);
	}

//#endregion
//#region task.ts
	const pendingTasks = new Map();
	function taskKey(ref) {
		return "task:" + (ref.id ?? String(ref));
	}
	function ensureTaskListener() {
		if (globalThis.__quickbeam_js_task_listener_setup) return;
		globalThis.__quickbeam_js_task_listener_setup = true;
		Beam.onMessage((msg) => {
			if (!msg || typeof msg !== "object") return;
			if (msg.type === "task_result" && msg.ref) {
				const entry = pendingTasks.get(taskKey(msg.ref));
				if (entry) {
					if (entry.timer) clearTimeout(entry.timer);
					if (entry.resolve) {
						pendingTasks.delete(taskKey(msg.ref));
						entry.resolve(msg.result);
					} else {
						entry.earlyResult = {
							ok: true,
							value: msg.result
						};
					}
				}
			} else if (msg.type === "task_error" && msg.ref) {
				const entry = pendingTasks.get(taskKey(msg.ref));
				if (entry) {
					if (entry.timer) clearTimeout(entry.timer);
					if (entry.reject) {
						pendingTasks.delete(taskKey(msg.ref));
						entry.reject(new BeamOtpError("BeamOtpError:exit", `Task failed: ${msg.error}`, { reason: msg.stack }));
					} else {
						entry.earlyResult = {
							ok: false,
							error: msg.error,
							stack: msg.stack
						};
					}
				}
			}
		});
	}
	const Task = {
		async_(fn) {
			ensureTaskListener();
			const ref = Beam.makeRef();
			const parentPid = Beam.self();
			const stored = {
				resolve: null,
				reject: null,
				timer: null,
				pid: null
			};
			pendingTasks.set(taskKey(ref), stored);
			const spawnPid = Beam.spawn(async () => {
				try {
					const result = await fn();
					Beam.send(parentPid, {
						type: "task_result",
						ref,
						result
					});
				} catch (err) {
					Beam.send(parentPid, {
						type: "task_error",
						ref,
						error: err instanceof Error ? err.message : String(err),
						stack: err instanceof Error ? err.stack : undefined
					});
				}
			});
			stored.pid = spawnPid;
			return {
				pid: spawnPid,
				ref,
				cancel() {
					const e = pendingTasks.get(taskKey(ref));
					if (e) {
						if (e.timer) clearTimeout(e.timer);
						if (e.pid) {
							Beam.send(e.pid, {
								type: "system",
								action: "shutdown",
								payload: "kill"
							});
						}
						pendingTasks.delete(taskKey(ref));
					}
				}
			};
		},
		await_(ref, timeout) {
			const ms = timeout ?? 5e3;
			return new Promise((resolve, reject) => {
				const entry = pendingTasks.get(taskKey(ref.ref));
				if (!entry) {
					reject(BeamOtpError.notFound("task", String(ref.ref)));
					return;
				}
				if (entry.earlyResult) {
					const er = entry.earlyResult;
					pendingTasks.delete(taskKey(ref.ref));
					if (er.ok) {
						resolve(er.value);
					} else {
						reject(new BeamOtpError("BeamOtpError:exit", `Task failed: ${er.error}`, { reason: er.stack }));
					}
					return;
				}
				entry.timer = setTimeout(() => {
					pendingTasks.delete(taskKey(ref.ref));
					reject(BeamOtpError.timeout(`Task.await for ref '${ref.ref}'`, ms));
					if (entry.pid) {
						Beam.send(entry.pid, {
							type: "system",
							action: "shutdown",
							payload: "kill"
						});
					}
				}, ms);
				entry.resolve = (result) => {
					if (entry.timer) clearTimeout(entry.timer);
					pendingTasks.delete(taskKey(ref.ref));
					resolve(result);
				};
				entry.reject = (err) => {
					if (entry.timer) clearTimeout(entry.timer);
					pendingTasks.delete(taskKey(ref.ref));
					reject(err);
				};
			});
		},
		async start(fn) {
			return Beam.spawn(fn);
		}
	};

//#endregion
//#region application.ts
	const runningApps = new Map();
	const Application = {
		async start(config) {
			const { id, supervisor: supConfig, env = {} } = config;
			if (runningApps.has(id)) {
				throw BeamOtpError.alreadyStarted(`Application '${id}'`);
			}
			const sup = await Supervisor.start(supConfig);
			const app = {
				id,
				supervisor: sup,
				getEnv(key) {
					return env[key];
				},
				putEnv(key, value) {
					env[key] = value;
				},
				async stop() {
					await sup.shutdown();
					runningApps.delete(id);
				}
			};
			runningApps.set(id, app);
			return app;
		},
		async stop(id) {
			const app = runningApps.get(id);
			if (!app) throw BeamOtpError.notFound("application", id);
			await app.stop();
		},
		which() {
			return Array.from(runningApps.entries()).map(([id]) => ({ id }));
		}
	};

//#endregion
//#region index.ts
	var __tmpSldQ4q_exports = /* @__PURE__ */ __export({
		Application: () => Application,
		Beam: () => Beam,
		BeamOtpError: () => BeamOtpError,
		GenServer: () => GenServer,
		Pool: () => Pool,
		Registry: () => Registry,
		Supervisor: () => Supervisor,
		Task: () => Task,
		findCause: () => findCause,
		getBeam: () => getBeam,
		retry: () => retry,
		setMockBeam: () => setMockBeam,
		sleep: () => sleep,
		withTimeout: () => withTimeout
	});

//#endregion
//#region __entry.ts
	globalThis.QuickbeamJs = __tmpSldQ4q_exports;

//#endregion
})();