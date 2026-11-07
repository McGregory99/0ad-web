// Array.prototype.sort and %TypedArray%.prototype.sort with a comparator, as SpiderMonkey 128
// implements them (js/src/builtin/Sorting-inl.h, ArraySortData::sortWithComparatorShared and
// ArraySortPrologue in builtin/Array.cpp): insertion sort up to 8 elements, otherwise insertion
// sort of 4-element windows followed by a bottom-up merge sort. Any correct stable sort gives the
// same result for a consistent comparator, but AI scripts also use inconsistent ones (e.g.
// `plans.sort(plan => plan.units.length)`), whose result depends on the algorithm. Without a
// comparator the engines agree, so the native sort is kept for that case.
'use strict';

const INSERTION_SORT_MAX_LENGTH = 8;
const INITIAL_WINDOW_SIZE = 4;

// Sorts vec[0..n) in place with lessOrEqual(x, y); vec may be longer (scratch space is separate).
function sortValues(vec, n, lessOrEqual) {
	if (n <= INSERTION_SORT_MAX_LENGTH) {
		for (let i = 1; i < n; i++) {
			const item = vec[i];
			let j = i - 1;
			do {
				if (lessOrEqual(vec[j], item))
					break;
				vec[j + 1] = vec[j];
			} while (j-- > 0);
			vec[j + 1] = item;
		}
		return vec;
	}
	for (let start = 0; start < n - 1; start += INITIAL_WINDOW_SIZE) {
		const end = Math.min(start + INITIAL_WINDOW_SIZE - 1, n - 1);
		for (let i = start + 1; i <= end; i++) {
			const item = vec[i];
			let j = i - 1;
			do {
				if (lessOrEqual(vec[j], item))
					break;
				vec[j + 1] = vec[j];
			} while (j-- > start);
			vec[j + 1] = item;
		}
	}
	let list = vec;
	let out = new Array(n);
	for (let windowSize = INITIAL_WINDOW_SIZE; windowSize < n; windowSize *= 2) {
		for (let start = 0; start < n; start += 2 * windowSize) {
			const mid = start + windowSize - 1;
			const end = Math.min(start + 2 * windowSize - 1, n - 1);
			if (mid >= end || lessOrEqual(list[mid], list[mid + 1])) {
				for (let i = start; i <= end; i++)
					out[i] = list[i];
				continue;
			}
			let i = start, j = mid + 1, k = start;
			while (i <= mid && j <= end)
				out[k++] = lessOrEqual(list[i], list[j]) ? list[i++] : list[j++];
			while (i <= mid)
				out[k++] = list[i++];
			while (j <= end)
				out[k++] = list[j++];
		}
		[list, out] = [out, list];
	}
	return list;
}

// RvalIsLessOrEqual: NaN counts as "less or equal".
function comparatorLessOrEqual(comparefn, undefinedFirst) {
	return (x, y) => {
		if (undefinedFirst) {
			if (x === undefined)
				return y === undefined; // CompareArrayElements: undefined sorts last
			if (y === undefined)
				return true;
		}
		const d = +comparefn(x, y);
		return Number.isNaN(d) || d <= 0;
	};
}

function install(global) {
	const arraySort = global.Array.prototype.sort;
	const sort = {
		sort(comparefn) {
			if (comparefn === undefined)
				return arraySort.call(this);
			if (typeof comparefn !== 'function')
				throw new TypeError('invalid Array.prototype.sort argument');
			const obj = Object(this);
			const length = Math.min(Math.max(Math.trunc(+obj.length) || 0, 0), Number.MAX_SAFE_INTEGER);
			if (length <= 1)
				return obj;
			const vec = [];
			for (let i = 0; i < length; i++)
				if (i in obj)
					vec.push(obj[i]);
			if (vec.length === 0)
				return obj;
			const n = vec.length;
			const sorted = sortValues(vec, n, comparatorLessOrEqual(comparefn, true));
			for (let i = 0; i < n; i++)
				obj[i] = sorted[i];
			for (let i = n; i < length; i++)
				delete obj[i];
			return obj;
		},
	}.sort;
	Object.defineProperty(global.Array.prototype, 'sort', { value: sort, writable: true, enumerable: false, configurable: true });

	const TypedArrayPrototype = Object.getPrototypeOf(global.Uint8Array.prototype);
	const typedArraySort = TypedArrayPrototype.sort;
	const sortTyped = {
		sort(comparefn) {
			if (comparefn === undefined)
				return typedArraySort.call(this);
			if (typeof comparefn !== 'function')
				throw new TypeError('invalid %TypedArray%.prototype.sort argument');
			const n = this.length;
			if (n <= 1)
				return this;
			const sorted = sortValues(Array.from(this), n, comparatorLessOrEqual(comparefn, false));
			for (let i = 0; i < Math.min(n, this.length); i++)
				this[i] = sorted[i];
			return this;
		},
	}.sort;
	Object.defineProperty(TypedArrayPrototype, 'sort', { value: sortTyped, writable: true, enumerable: false, configurable: true });
}

if (typeof module !== 'undefined')
	module.exports = { install, sortValues };
else
	self.ZeroADSpiderMonkeySort = { install, sortValues };
