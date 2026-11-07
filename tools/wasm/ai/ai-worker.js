// T0.6: runs 0 A.D. AI scripts (Petra) in the host JavaScript engine (V8 in Chrome and Node) instead
// of the SpiderMonkey interpreter compiled to wasm. It mirrors CAIWorker in
// source/simulation/components/CCmpAIManager.cpp; keep both in sync.
//
// Main thread -> worker: {id, request} messages, answered with {id, response} (async).
// Worker -> main thread: synchronous RPC for the engine/simulation functions the AI calls
// (Engine.GetTemplate, Engine.ComputePath, VFS reads, Sim.*, SimEngine.QueryInterface). The worker
// writes the request into a SharedArrayBuffer, posts {type: 'rpc'} and blocks with Atomics.wait
// until the main thread has called the wasm export and written the answer.
'use strict';

const isNode = typeof process !== 'undefined' && !!(process.versions && process.versions.node);
let post, loadGlobalScript, importModule, Codec;
if (isNode) {
	const { parentPort } = require('node:worker_threads');
	const fs = require('node:fs');
	const vm = require('node:vm');
	const { fileURLToPath } = require('node:url');
	Codec = require('./codec.js');
	post = (message) => parentPort.postMessage(message);
	parentPort.on('message', (message) => onMessage(message));
	loadGlobalScript = (url) => vm.runInThisContext(fs.readFileSync(fileURLToPath(url), 'utf8'), { filename: url });
	importModule = (url) => import(url);
} else {
	importScripts(new URL('codec.js', self.location.href).href);
	Codec = self.ZeroADCodec;
	post = (message) => self.postMessage(message);
	self.onmessage = (event) => onMessage(event.data);
	loadGlobalScript = (url) => importScripts(url);
	importModule = (url) => import(url);
}

// --- synchronous RPC to the main thread ---------------------------------------------------------
const encoder = new TextEncoder();
const decoder = new TextDecoder();
let ctrl = null; // Int32Array: [state (0 idle, 1 request, 2 response), byte length]
let data = null; // Uint8Array on a SharedArrayBuffer
let turnCache = new Map();

function rpc(request) {
	const bytes = encoder.encode(Codec.encode(request));
	if (bytes.length > data.length)
		throw new Error('AI RPC request too large: ' + bytes.length);
	data.set(bytes);
	ctrl[1] = bytes.length;
	Atomics.store(ctrl, 0, 1);
	post({ type: 'rpc' });
	Atomics.wait(ctrl, 0, 1);
	const text = decoder.decode(data.slice(0, ctrl[1]));
	Atomics.store(ctrl, 0, 0);
	const response = Codec.decode(text);
	if (response.error)
		throw new Error('AI RPC ' + request.op + ' failed: ' + response.error);
	return response.v;
}

// Simulation state does not change while the AI computes, so read-only queries can be cached
// for the duration of one computation.
const READ_ONLY_METHOD = /^(Get|Is|Has|Are|Can|Count)/;
function rpcTurnCached(request, cacheable) {
	if (!cacheable)
		return rpc(request);
	const key = Codec.encode(request);
	if (turnCache.has(key))
		return turnCache.get(key);
	const value = rpc(request);
	turnCache.set(key, value);
	return value;
}

// --- the AI realm globals ------------------------------------------------------------------------
class Rand48 {
	seed(seed) { this.x = (BigInt(seed >>> 0) << 16n) | 0x330En; }
	next() {
		this.x = (this.x * 0x5DEECE66Dn + 0xBn) & 0xFFFFFFFFFFFFn;
		return Number(this.x >> 17n);
	}
	// Same as generate_uniform_real() in ScriptInterface.cpp with min 0 and max 1.
	uniform() {
		for (;;) {
			const r = this.next() / 2147483648 * (1.0 - 0.0) + 0.0;
			if (r < 1.0)
				return r;
		}
	}
	state() { return this.x.toString(); }
}
const rng = new Rand48();
rng.seed(1);

function deepfreeze(value) {
	if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
		Object.freeze(value);
		for (const key of Object.keys(value))
			deepfreeze(value[key]);
	}
	return value;
}

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
			const method = path[path.length - 1];
			return rpcTurnCached({ op: 'simcall', root, path, args }, READ_ONLY_METHOD.test(method));
		},
	});
}
function simGet(root, path) {
	const key = root + '\u0000' + path.join('\u0000');
	if (simGetCache.has(key))
		return simGetCache.get(key);
	const result = rpc({ op: 'simget', root, path });
	if (result.kind !== 'value') {
		const handle = simProxy(root, path);
		simGetCache.set(key, handle);
		return handle;
	}
	if (result.v === null || typeof result.v !== 'object')
		simGetCache.set(key, result.v);
	return result.v;
}
function queryInterface(ent, iid) {
	const found = rpcTurnCached({ op: 'qi', ent, iid }, true);
	if (found !== true)
		return found;
	return new Proxy({}, {
		get(target, method) {
			if (typeof method === 'symbol')
				return undefined;
			return (...args) => rpcTurnCached({ op: 'qicall', ent, iid, method, args }, READ_ONLY_METHOD.test(method));
		},
	});
}

const state = {
	players: [], // {name, player, difficulty, behavior, useShared, obj, commands: [encoded]}
	shared: null,
	hasShared: false,
	templates: null,
	passabilityMap: null,
	territoryMap: null,
	baseUrl: '',
	modules: new Map(),
};

function postCommand(player, cmd) {
	for (const ai of state.players)
		if (ai.player === player) {
			ai.commands.push(Codec.encode(cmd)); // a snapshot, like Script::WriteStructuredClone
			return;
		}
	globalThis.error('Invalid playerid in PostCommand!');
}

function installGlobals(engineNames) {
	const g = globalThis;
	const log = (level) => (...args) => post({ type: 'log', level, text: args.map(String).join(' ') });
	g.print = log('print');
	g.log = log('log');
	g.warn = log('warn');
	g.error = log('error');
	g.deepfreeze = deepfreeze;
	const local = {
		ProfileStart() {},
		ProfileStop() {},
		ProfileAttribute() {},
		PostCommand: postCommand,
		Exit() {},
		DumpImage() {},
	};
	const engine = {};
	for (const name of engineNames)
		engine[name] = local[name] || ((...args) => rpc({ op: 'engine', name, args }));
	g.Engine = engine;
	g.Sim = simProxy('Sim', []);
	g.SimEngine = simProxy('SimEngine', []);
	Object.defineProperty(Math, 'random', { value: () => rng.uniform(), writable: false, configurable: false, enumerable: true });
}

async function loadModule(path) {
	if (!state.modules.has(path))
		state.modules.set(path, await importModule(state.baseUrl + path));
	return state.modules.get(path);
}

function mapObject(map, mem, info) {
	// Same shape as Script::ToJSVal<Grid<T>>: {width, height, data}. The object and its data array
	// are kept across turns (C++ memcpy's into the existing array), because the AI may keep references.
	const Type = info.bytes === 2 ? Uint16Array : Uint8Array;
	const length = info.width * info.height;
	if (!map || map.width !== info.width || map.height !== info.height || info.recreate)
		map = { width: info.width, height: info.height, data: new Type(length) };
	map.data.set(new Type(mem, info.ptr, length));
	return map;
}

function updateMaps(request) {
	if (request.passabilityMap)
		state.passabilityMap = mapObject(state.passabilityMap, request.memory, request.passabilityMap);
	if (request.territoryMap)
		state.territoryMap = mapObject(state.territoryMap, request.memory, request.territoryMap);
}

function collectCommands() {
	return state.players.map((ai) => ({ player: ai.player, commands: ai.commands }));
}

// --- requests (mirror CAIWorker) -----------------------------------------------------------------
const handlers = {
	init(request) {
		ctrl = new Int32Array(request.control);
		data = new Uint8Array(request.data);
		state.baseUrl = request.baseUrl;
		installGlobals(request.engineNames);
		for (const path of request.globalScripts)
			loadGlobalScript(state.baseUrl + path);
		return {};
	},
	seed(request) {
		rng.seed(request.seed);
		return {};
	},
	templates(request) {
		state.templates = Codec.decode(request.templates);
		return {};
	},
	async addPlayer(request) {
		const metadata = request.metadata; // data.json
		const module = await loadModule('simulation/ai/' + request.name + '/' + metadata.filename);
		const ctor = module[metadata.constructor];
		const useShared = !!metadata.useShared;
		const settings = { player: request.player, difficulty: request.difficulty, behavior: request.behavior };
		if (!useShared)
			settings.templates = state.templates;
		const ai = { name: request.name, player: request.player, difficulty: request.difficulty, behavior: request.behavior, useShared, obj: new ctor(settings), commands: [] };
		if (!state.hasShared)
			state.hasShared = useShared;
		state.players.push(ai);
		return { useShared };
	},
	async loadShared() {
		const module = await loadModule('simulation/ai/common-api/shared.js');
		const players = {};
		state.players.forEach((ai, i) => { players[i] = ai.player; });
		state.shared = new module.SharedScript({ players, templates: state.templates });
		return {};
	},
	gamestateInit(request) {
		turnCache = new Map();
		const gameState = Codec.decode(request.state);
		updateMaps(request);
		if (state.hasShared) {
			gameState.passabilityMap = state.passabilityMap;
			gameState.territoryMap = state.territoryMap;
			state.shared.init(gameState);
			for (const ai of state.players)
				if (ai.useShared) {
					ai.commands = [];
					ai.obj.Init(gameState, ai.player, state.shared);
				}
		}
		return { commands: collectCommands() };
	},
	compute(request) {
		turnCache = new Map();
		const gameState = Codec.decode(request.state);
		updateMaps(request);
		gameState.passabilityMap = state.passabilityMap;
		gameState.territoryMap = state.territoryMap;
		if (state.hasShared)
			state.shared.onUpdate(gameState);
		for (const ai of state.players) {
			ai.commands = [];
			if (state.hasShared && ai.useShared)
				ai.obj.HandleMessage(gameState, ai.player, state.shared);
			else
				ai.obj.HandleMessage(gameState, ai.player);
		}
		return { commands: collectCommands(), rng: rng.state() };
	},
};

let queue = Promise.resolve();
function onMessage(message) {
	if (!message || message.id === undefined)
		return;
	queue = queue.then(async () => {
		try {
			const response = await handlers[message.request.type](message.request);
			post({ id: message.id, response });
		} catch (e) {
			post({ id: message.id, error: String(e && e.stack || e) });
		}
	});
}
