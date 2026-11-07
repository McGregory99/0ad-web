// T0.6: runs 0 A.D. AI scripts (Petra) in the host JavaScript engine (V8 in Node and Chrome)
// instead of the SpiderMonkey interpreter compiled to wasm. It mirrors CAIWorker in
// source/simulation2/components/CCmpAIManager.cpp (the in-process AI); keep both in sync.
//
// Transport (see tools/wasm/node-lib.js): two SharedArrayBuffers shared with the engine thread.
//   ctrl (Int32Array): [0] state: 0 idle, 1 message for the worker, 2 message for the engine;
//                      [1] message length; [2] kind of a message for the engine (0 = final reply,
//                      else an AIRemote::ServiceKind callback, source/simulation2/components/AIRemote.h).
//   data (growable Uint8Array): the UTF-8 message.
// The engine sends one request (codec text, see codec.js) and blocks. The worker runs it and may
// call back synchronously (Atomics.wait) for anything that lives in the engine: Engine.* functions,
// the Sim / SimEngine globals, file contents and logging. Then it posts the final reply.
// Every request carries the engine's boost::rand48 state and every reply the state after the AI
// ran, so Math.random continues the same sequence as the in-process AI.
'use strict';

const SERVICE_DISPATCH = 1;
const SERVICE_MODULE_CODE = 3;
const SERVICE_GLOBAL_SCRIPTS = 4;
const SERVICE_GLOBAL_CODE = 5;

const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);
let Codec, SpiderMonkeySort, workerData, evaluateGlobalScript, importModule;
if (isNode) {
	const workerThreads = require('node:worker_threads');
	const vm = require('node:vm');
	const nodeModule = require('node:module');
	const posix = require('node:path').posix;
	Codec = require('./codec.js');
	SpiderMonkeySort = require('./sm-sort.js');
	workerData = workerThreads.workerData;
	evaluateGlobalScript = (code, filename) => vm.runInThisContext(code, { filename });
	// AI modules import each other with VFS paths ("simulation/ai/common-api/entity.js"), resolved
	// like ModuleLoader.cpp does (lexically normalized, never relative to the importer).
	const SCHEME = 'zeroad-vfs:';
	nodeModule.registerHooks({
		resolve(specifier, context, nextResolve) {
			if (specifier.startsWith(SCHEME))
				return { url: specifier, shortCircuit: true };
			if (context.parentURL && context.parentURL.startsWith(SCHEME))
				return { url: SCHEME + posix.normalize(specifier), shortCircuit: true };
			return nextResolve(specifier, context);
		},
		load(url, context, nextLoad) {
			if (url.startsWith(SCHEME))
				return { format: 'module', source: readEngineFile(SERVICE_MODULE_CODE, url.slice(SCHEME.length)), shortCircuit: true };
			return nextLoad(url, context);
		},
	});
	importModule = (path) => import(SCHEME + posix.normalize(path));
} else {
	// Browser Web Worker: started with {ctrl, data, memory} posted as the first message.
	// Module loading is not implemented yet (see reports/T0.6.md for the design).
	importScripts(new URL('codec.js', self.location.href).href, new URL('sm-sort.js', self.location.href).href);
	Codec = self.ZeroADCodec;
	SpiderMonkeySort = self.ZeroADSpiderMonkeySort;
	evaluateGlobalScript = (code) => (0, eval)(code);
	// AI modules are static files under ai/modules/ (tools/wasm/build-engine.sh rewrites their
	// VFS-root import specifiers to relative ones).
	importModule = (path) => import(new URL('modules/' + path, self.location.href).href);
}

// --- transport -----------------------------------------------------------------------------------
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let ctrl = null;
let data = null;
let memory = null;

function readMessage() {
	return decoder.decode(data.slice(0, ctrl[1]));
}

function postToEngine(kind, text) {
	const bytes = encoder.encode(text);
	const buffer = data.buffer;
	if (bytes.length > buffer.byteLength)
		buffer.grow(Math.min(buffer.maxByteLength, Math.max(bytes.length, 2 * buffer.byteLength)));
	data.set(bytes);
	ctrl[1] = bytes.length;
	ctrl[2] = kind;
	Atomics.store(ctrl, 0, 2);
	Atomics.notify(ctrl, 0);
}

// Per-request timing (ZEROAD_AI_WORKER_STATS=<file>, Node only): one line per request with
// "<type> <ms> <callbacks> <callback ms> <cached queries> <request bytes>".
const stats = { calls: 0, ms: 0, cached: 0 };
let writeStats = null;
// Per-callback totals (same switch): <file>.keys.json, rewritten every 200 requests.
const keyStats = new Map();
let dumpKeys = null;
let requestCount = 0;
if (isNode && process.env.ZEROAD_AI_WORKER_STATS) {
	const fs = require('node:fs');
	const fd = fs.openSync(process.env.ZEROAD_AI_WORKER_STATS, 'w');
	writeStats = (line) => fs.writeSync(fd, line + '\n');
	dumpKeys = () => fs.writeFileSync(process.env.ZEROAD_AI_WORKER_STATS + '.keys.json',
		JSON.stringify(Object.fromEntries([...keyStats].sort((a, b) => b[1].ms - a[1].ms)), null, 1));
}
function rpcKey(request) {
	switch (request.op) {
	case 'engine': return `engine:${request.name}`;
	case 'simcall':
	case 'simget': return `${request.op}:${request.root}.${request.path.join('.')}`;
	case 'qi': return `qi:${request.iid}`;
	case 'qicall': return `qicall:${request.iid}.${request.method}`;
	default: return String(request.op);
	}
}
function countKey(request, ms, cached) {
	const key = rpcKey(request);
	let entry = keyStats.get(key);
	if (!entry)
		keyStats.set(key, entry = { calls: 0, ms: 0, cached: 0 });
	if (cached)
		++entry.cached;
	else {
		++entry.calls;
		entry.ms += ms;
	}
}

// ZEROAD_AI_TRACE_MATH=<file> (diagnosis, Node only): the same "MT" lines the in-process AI prints
// (AI_TRACE_MATH_JS in CCmpAIManager.cpp), compared by tools/bench/mathcmp.mjs.
let traceMath = null;
if (isNode && process.env.ZEROAD_AI_TRACE_MATH) {
	const fs = require('node:fs');
	const fd = fs.openSync(process.env.ZEROAD_AI_TRACE_MATH, 'w');
	traceMath = (line) => fs.writeSync(fd, line);
}
function installMathTrace() {
	for (const name of ['sin', 'cos', 'tan', 'asin', 'acos', 'atan', 'atan2', 'sinh', 'cosh', 'tanh', 'asinh',
		'acosh', 'atanh', 'exp', 'expm1', 'log', 'log1p', 'log2', 'log10', 'pow', 'hypot', 'cbrt']) {
		const f = Math[name];
		Math[name] = function(...args) {
			const result = f.apply(Math, args);
			traceMath('MT ' + name + ' ' + args.join(',') + ' ' + result + '\n');
			return result;
		};
	}
}

// ZEROAD_AI_TRACE_STATE=<file> (diagnosis, Node only): the "ST"/"SD" lines of CCmpAIManager.cpp
// (AITraceState) for every computation, compared by tools/bench/statecmp.mjs.
let traceState = null;
if (isNode && process.env.ZEROAD_AI_TRACE_STATE) {
	const fs = require('node:fs');
	const fd = fs.openSync(process.env.ZEROAD_AI_TRACE_STATE, 'w');
	traceState = (line) => fs.writeSync(fd, line + '\n');
}
let tracedComputations = 0;
function fnv1a(bytes) {
	let hash = 2166136261;
	for (let i = 0; i < bytes.length; ++i)
		hash = Math.imul(hash ^ bytes[i], 16777619) >>> 0;
	return hash.toString(16).padStart(8, '0');
}
function stateText(state) {
	const { passabilityMap, territoryMap, ...rest } = state;
	try {
		return Codec.encode(rest);
	} catch (e) {
		// The AI may attach its own (cyclic) objects to the state.
		return 'unencodable: ' + e;
	}
}
function gridHash(map) {
	return map ? fnv1a(new Uint8Array(map.data.buffer, map.data.byteOffset, map.data.byteLength)) : '00000000';
}
function traceComputation(before, after) {
	const bytes = encoder.encode(before);
	traceState(`ST ${tracedComputations++} ${fnv1a(bytes)} ${bytes.length} ${gridHash(ai.passabilityMap)} ${gridHash(ai.territoryMap)} ${before !== after ? 1 : 0}`);
	if (before === after)
		return;
	let first = 0;
	while (first < before.length && first < after.length && before[first] === after[first])
		++first;
	const from = Math.max(0, first - 80);
	traceState(`SD ${first} before: ${before.substr(from, 240)}`);
	traceState(`SD ${first} after:  ${after.substr(from, 240)}`);
}

// Synchronous callback to the engine thread.
function callEngine(kind, text) {
	const t0 = performance.now();
	postToEngine(kind, text);
	Atomics.wait(ctrl, 0, 2);
	const reply = readMessage();
	++stats.calls;
	stats.ms += performance.now() - t0;
	return reply;
}

function rpc(request) {
	const t0 = writeStats ? performance.now() : 0;
	const response = Codec.decode(callEngine(SERVICE_DISPATCH, Codec.encode(request)));
	if (writeStats)
		countKey(request, performance.now() - t0, false);
	if (response.error !== undefined)
		throw new Error(response.error);
	return response.v;
}

function readEngineFile(kind, path) {
	const text = callEngine(kind, path);
	if (text[0] !== 'O')
		throw new Error(text.slice(1));
	return text.slice(1);
}

// The simulation does not change while the AI computes, so read-only queries are cached for one
// computation. A call that may change the simulation (e.g. AddModifiers) clears the cache.
const READ_ONLY_METHOD = /^(Get|Is|Has|Are|Can|Count)/;
let turnCache = new Map();
function rpcCached(request, cacheable) {
	if (!cacheable) {
		turnCache = new Map();
		return rpc(request);
	}
	const key = Codec.encode(request);
	if (turnCache.has(key)) {
		++stats.cached;
		if (writeStats)
			countKey(request, 0, true);
		return turnCache.get(key);
	}
	const value = rpc(request);
	turnCache.set(key, value);
	return value;
}

// --- AI realm globals (ScriptInterface.cpp and CAIWorker::Init) ------------------------------------
class Rand48 {
	constructor() { this.x = 0n; }
	setState(text) { this.x = BigInt(text); }
	state() { return this.x.toString(); }
	next() {
		this.x = (this.x * 0x5DEECE66Dn + 0xBn) & 0xFFFFFFFFFFFFn;
		return Number(this.x >> 17n);
	}
	// generate_uniform_real() in ScriptInterface.cpp with min 0 and max 1.
	uniform() {
		for (;;) {
			const r = this.next() / 2147483648 * (1.0 - 0.0) + 0.0;
			if (r < 1.0)
				return r;
		}
	}
}
const rng = new Rand48();

function deepfreeze(value) {
	if (value === null || typeof value !== 'object')
		throw new Error('deepfreeze requires exactly one object as an argument.');
	freezeAll(value);
	return value;
}
function freezeAll(value) {
	if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const key of Object.keys(value))
			freezeAll(value[key]);
	}
}

// Sim and SimEngine: proxies whose property reads and calls run in the engine.
const simGetCache = new Map();
function simProxy(root, path) {
	return new Proxy(function() {}, {
		get(target, key) {
			if (typeof key === 'symbol')
				return undefined;
			if (root === 'SimEngine' && path.length === 0 && key === 'QueryInterface')
				return queryInterface;
			return simGet(root, path.concat([key]));
		},
		apply(target, thisArg, args) {
			return rpcCached({ op: 'simcall', root, path, args }, READ_ONLY_METHOD.test(path[path.length - 1]));
		},
	});
}
function simGet(root, path) {
	const key = root + '\u0000' + path.join('\u0000');
	if (simGetCache.has(key))
		return simGetCache.get(key);
	const result = rpc({ op: 'simget', root, path });
	// Objects and functions stay in the engine; constants (IIDs, SYSTEM_ENTITY) are cached.
	const value = result.kind === 'value' ? result.v : simProxy(root, path);
	simGetCache.set(key, value);
	return value;
}
function queryInterface(ent, iid) {
	const found = rpcCached({ op: 'qi', ent, iid }, true);
	if (found !== true)
		return found;
	return new Proxy({}, {
		get(target, method) {
			if (typeof method === 'symbol')
				return undefined;
			return (...args) => rpcCached({ op: 'qicall', ent, iid, method, args }, READ_ONLY_METHOD.test(method));
		},
	});
}

const ai = {
	players: [], // {name, player, useShared, obj, commands}
	shared: null,
	templates: null,
	passabilityMap: null,
	territoryMap: null,
	Vector2D: null,
};

function logAt(level) {
	return (...args) => {
		const text = level === 'print' ? args.map(String).join('') : String(args[0]);
		rpc({ op: 'log', level, text });
	};
}

function reportError(e) {
	globalThis.error(String(e && e.stack || e));
}

function postCommand(player, cmd) {
	const id = player | 0;
	for (const p of ai.players)
		if (p.player === id) {
			p.commands.push(structuredClone(cmd)); // a snapshot, like Script::WriteStructuredClone
			return;
		}
	globalThis.error('Invalid playerid in PostCommand!');
}

function installGlobals(engineNames) {
	const g = globalThis;
	// The engine's script realms expose the global object as `global` (Node has it; a Web Worker does not).
	g.global = g;
	// Comparator sorts must order elements like SpiderMonkey does (see sm-sort.js).
	SpiderMonkeySort.install(g);
	for (const level of ['print', 'log', 'warn', 'error'])
		g[level] = logAt(level);
	g.deepfreeze = deepfreeze;
	g.clone = (value) => {
		if (value === null || value === undefined)
			throw new Error('deepcopy requires one argument.');
		return structuredClone(value);
	};
	// Only used in Petra debug output; SpiderMonkey has it, V8 does not.
	if (typeof g.uneval !== 'function')
		g.uneval = (value) => JSON.stringify(value);
	const local = {
		ProfileStart() {},
		ProfileStop() {},
		ProfileAttribute() {},
		PostCommand: postCommand,
		GetTemplate(name) {
			// The engine returns a deep-frozen CParamNode value.
			const template = rpc({ op: 'engine', name: 'GetTemplate', args: [name] });
			return template !== null && typeof template === 'object' ? deepfreeze(template) : template;
		},
		ComputePath(...args) {
			// The engine returns an array of Vector2D (Script::ToJSVal<CFixedVector2D>).
			const path = rpc({ op: 'engine', name: 'ComputePath', args });
			return path.map((p) => new ai.Vector2D(p.x, p.y));
		},
	};
	const engine = {};
	for (const name of engineNames)
		engine[name] = local[name] || ((...args) => rpc({ op: 'engine', name, args }));
	g.Engine = engine;
	g.Sim = simProxy('Sim', []);
	g.SimEngine = simProxy('SimEngine', []);
	Object.defineProperty(Math, 'random', { value: () => rng.uniform(), writable: false, configurable: false, enumerable: true });
}

function mapObject(map, info) {
	// Script::ToJSVal<Grid<T>> makes {width, height, data} with Script::CreateObject, which sets the
	// properties in reverse order. The object is kept while the dimensions do not change, and its
	// data is overwritten, as CAIWorker::UpdatePathfinder / UpdateTerritoryMap do.
	const Type = info.bytes === 2 ? Uint16Array : Uint8Array;
	const length = info.width * info.height;
	if (!map || info.recreate)
		map = { data: new Type(length), height: info.height, width: info.width };
	map.data.set(new Type(memory.buffer, info.ptr, length));
	return map;
}

function updateMaps(request) {
	if (request.passabilityMap)
		ai.passabilityMap = mapObject(ai.passabilityMap, request.passabilityMap);
	if (request.territoryMap)
		ai.territoryMap = mapObject(ai.territoryMap, request.territoryMap);
}

function addMaps(gameState) {
	// Script::SetProperty(..., constant = true): read-only and permanent.
	for (const name of ['passabilityMap', 'territoryMap'])
		Object.defineProperty(gameState, name, { value: ai[name], writable: false, enumerable: true, configurable: false });
}

function commandSets() {
	return ai.players.map((p) => p.commands);
}

// --- requests (mirror CAIWorker) ---------------------------------------------------------------
const handlers = {
	init(request) {
		installGlobals(request.engineNames);
		// ScriptInterface::LoadGlobalScripts
		const paths = readEngineFile(SERVICE_GLOBAL_SCRIPTS, '').split('\n').filter((p) => p);
		for (const path of paths) {
			try {
				evaluateGlobalScript(readEngineFile(SERVICE_GLOBAL_CODE, path), path);
			} catch (e) {
				reportError(e);
				globalThis.error('LoadGlobalScripts: Failed to load script ' + path);
				break;
			}
		}
		if (traceMath)
			installMathTrace();
		ai.Vector2D = evaluateGlobalScript('typeof Vector2D === "undefined" ? undefined : Vector2D', '(vector2d)');
		return {};
	},
	templates(request) {
		ai.templates = request.templates;
		return {};
	},
	async addPlayer(request) {
		const metadata = request.metadata;
		const module = await importModule('simulation/ai/' + request.name + '/' + metadata.filename);
		const ctor = module[metadata.constructor];
		if (typeof ctor !== 'function')
			throw new Error("can't find constructor '" + metadata.constructor + "'");
		// Script::CreateObject order (reversed), then templates.
		const settings = { behavior: request.behavior, difficulty: request.difficulty, player: request.player };
		if (!request.useShared)
			settings.templates = ai.templates;
		const obj = new ctor(settings);
		ai.players.push({ name: request.name, player: request.player, useShared: request.useShared, obj, commands: [] });
		return {};
	},
	async loadShared() {
		const module = await importModule('simulation/ai/common-api/shared.js');
		const players = {};
		ai.players.forEach((p, i) => { players[i] = p.player; });
		ai.shared = new module.SharedScript({ templates: ai.templates, players });
		return {};
	},
	gamestateInit(request) {
		turnCache = new Map();
		const gameState = request.state;
		updateMaps(request);
		if (request.hasShared) {
			addMaps(gameState);
			try {
				ai.shared.init(gameState);
			} catch (e) {
				reportError(e);
			}
			for (const p of ai.players)
				if (p.useShared) {
					p.commands = [];
					try {
						p.obj.Init(gameState, p.player, ai.shared);
					} catch (e) {
						reportError(e);
					}
				}
		}
		return { commands: commandSets() };
	},
	compute(request) {
		if (traceMath)
			traceMath('MT compute\n');
		turnCache = new Map();
		const gameState = request.state;
		updateMaps(request);
		addMaps(gameState);
		const traceBefore = traceState ? stateText(gameState) : null;
		if (request.hasShared) {
			try {
				ai.shared.onUpdate(gameState);
			} catch (e) {
				reportError(e);
			}
		}
		for (const p of ai.players) {
			p.commands = [];
			try {
				if (request.hasShared && p.useShared)
					p.obj.HandleMessage(gameState, p.player, ai.shared);
				else
					p.obj.HandleMessage(gameState, p.player);
			} catch (e) {
				reportError(e);
			}
		}
		if (traceState)
			traceComputation(traceBefore, stateText(gameState));
		return { commands: commandSets() };
	},
};

// Waits synchronously: Node's Atomics.waitAsync in a worker missed wake-ups from the blocked
// engine thread (a standalone test timed out after 3 round trips). The event loop still runs
// while a request awaits (dynamic import of AI modules).
async function serve() {
	for (;;) {
		let state;
		while ((state = Atomics.load(ctrl, 0)) !== 1)
			Atomics.wait(ctrl, 0, state);
		let reply;
		let type = '?';
		const t0 = performance.now();
		const size = ctrl[1];
		stats.calls = stats.ms = stats.cached = 0;
		try {
			const request = Codec.decode(readMessage());
			type = request.type;
			if (request.rng !== undefined)
				rng.setState(request.rng);
			reply = (await handlers[request.type](request)) || {};
		} catch (e) {
			reply = { error: String(e && e.stack || e) };
		}
		reply.rng = rng.state();
		if (writeStats)
			writeStats(`${type} ${(performance.now() - t0).toFixed(3)} ${stats.calls} ${stats.ms.toFixed(3)} ${stats.cached} ${size}`);
		if (dumpKeys && ++requestCount % 200 === 0)
			dumpKeys();
		postToEngine(0, Codec.encode(reply));
	}
}

function start(init) {
	ctrl = new Int32Array(init.ctrl);
	data = new Uint8Array(init.data);
	memory = init.memory;
	serve();
}

if (isNode) {
	// The engine thread is blocked while the worker runs, so console output would only appear
	// after the engine returns: report fatal errors directly on stderr.
	const fatal = (e) => require('node:fs').writeSync(2, 'AI worker: fatal: ' + String(e && e.stack || e) + '\n');
	process.on('uncaughtException', fatal);
	process.on('unhandledRejection', fatal);
	start(workerData);
}
else
	self.onmessage = (event) => { self.onmessage = null; start(event.data); };
