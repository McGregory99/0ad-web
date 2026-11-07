// Lossless JSON codec for plain script data crossing between SpiderMonkey (wasm) and the host
// JS engine (T0.6). Plain JSON loses undefined, NaN, +-Infinity, -0 and typed arrays; they are
// written as tagged strings/objects and restored in place (keeping properties whose value is
// undefined, which JSON.parse revivers would delete). Must stay in sync with the copy embedded in
// CCmpAIManager.cpp (AI_CODEC_JS).
var ZeroADCodec = (function() {
	const TAG = '\u0000';
	function replacer(key, value) {
		if (value === undefined)
			return TAG + 'u';
		if (typeof value === 'number') {
			if (Number.isNaN(value))
				return TAG + 'n';
			if (value === Infinity)
				return TAG + 'i';
			if (value === -Infinity)
				return TAG + '-i';
			if (value === 0 && 1 / value < 0)
				return TAG + '-0';
		}
		if (typeof value === 'string' && value.charCodeAt(0) === 0)
			return TAG + 's' + value;
		if (ArrayBuffer.isView(value) && !(value instanceof DataView))
			return { [TAG + 'ta']: value.constructor.name, data: Array.from(value) };
		return value;
	}
	function revive(value) {
		if (typeof value === 'string') {
			if (value.charCodeAt(0) !== 0)
				return value;
			switch (value.slice(1)) {
			case 'u': return undefined;
			case 'n': return NaN;
			case 'i': return Infinity;
			case '-i': return -Infinity;
			case '-0': return -0;
			}
			if (value[1] === 's')
				return value.slice(2);
			return value;
		}
		if (value === null || typeof value !== 'object')
			return value;
		if (Array.isArray(value)) {
			for (let i = 0; i < value.length; ++i)
				value[i] = revive(value[i]);
			return value;
		}
		const taType = value[TAG + 'ta'];
		if (taType !== undefined)
			return new globalThis[taType](value.data);
		for (const key of Object.keys(value))
			value[key] = revive(value[key]);
		return value;
	}
	return {
		// The value is wrapped in a one-element array so a top-level undefined survives too.
		encode: (value) => JSON.stringify([value], replacer),
		decode: (text) => revive(JSON.parse(text))[0],
	};
})();
if (typeof module !== 'undefined')
	module.exports = ZeroADCodec;
