"""Compare two replay profile.txt files (PS profiler snapshots, one every 20 turns).

Sums the msec/frame of every profiler node over all snapshots and prints the nodes with the most
time in the second file, with the ratio second/first. Usage: profilediff.py native.txt wasm.txt [depth]
"""
import re
import sys
from collections import defaultdict

ROW = re.compile(r'^((?:[|\' ] )*)[|\'](?:-)(.+?)\s*\|\s*([\d.]*)\s*\|\s*([\d.]*)\s*\|')


def load(path, max_depth):
	totals = defaultdict(float)
	in_root = False
	stack = []
	for line in open(path, encoding='utf-8', errors='replace'):
		if line.startswith('Profiling Information for: root'):
			in_root, stack = True, []
			continue
		if line.startswith('Script statistics') or line.startswith('====='):
			in_root = False
			continue
		if not in_root:
			continue
		m = ROW.match(line)
		if not m or not m.group(4):
			continue
		depth = len(m.group(1)) // 2
		name = m.group(2).strip()
		stack = stack[:depth] + [name]
		if depth <= max_depth:
			totals[' > '.join(stack)] += float(m.group(4))
	return totals


def main():
	depth = int(sys.argv[3]) if len(sys.argv) > 3 else 2
	a, b = load(sys.argv[1], depth), load(sys.argv[2], depth)
	print(f'{"first":>10} {"second":>10} {"ratio":>6}  node (summed msec/frame over snapshots)')
	for key in sorted(b, key=b.get, reverse=True)[:40]:
		ratio = b[key] / a[key] if a.get(key) else float('nan')
		print(f'{a.get(key, 0):10.1f} {b[key]:10.1f} {ratio:6.1f}  {key}')


if __name__ == '__main__':
	main()
